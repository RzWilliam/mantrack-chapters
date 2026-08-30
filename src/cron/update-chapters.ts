#!/usr/bin/env node
/**
 * Update Chapters Cron Script
 *
 * This script is called automatically every 2 hours by GitHub Actions to:
 * 1. Find ALL mangas that HAVE CHAPTERS in the database
 * 2. Among those, select ALL mangas that have not been updated in the last 2h
 * 3. Update their chapters from all available providers
 * 4. Update the last_chapters_update timestamp
 *
 * IMPORTANT: Only mangas with existing chapters are updated (not all mangas in DB)
 *
 * Triggers:
 * - GitHub Actions: Every 2 hours (.github/workflows/update-chapters.yml)
 * - Manual: Via npm run cron:update-chapters
 *
 * ⚠️ Ce script vit dans le dépôt PUBLIC `mantrack-chapters`, séparé de
 * l'application (dépôt privé) : le cron consomme ~3 400 min d'Actions par mois,
 * bien au-delà des 2 000 min/mois gratuites d'un dépôt privé. Les minutes ne
 * sont illimitées que sur un dépôt public. Cf. README.md §« Pourquoi ce dépôt ».
 */

import { supabaseAdmin } from "../lib/supabaseAdmin";
import { ChapterService } from "../chapterService";
import { scraperManager } from "../scrapers/scraperManager";
import { scraperStats } from "../lib/scraperStats";
import {
  buildProviderAlerts,
  buildRunSummary,
  emitAlerts,
  writeRunSummary,
} from "../lib/runSummary";
import {
  DEFAULT_TIERS,
  parseTiers,
  tierFor,
  type RefreshTier,
} from "../lib/refreshTiers";

// Paliers de cadence. Une série dormante n'a pas besoin du rythme d'une série qui
// publie chaque semaine (cf. src/lib/refreshTiers.ts). Une surcharge `CRON_TIERS`
// illisible est ignorée : mieux vaut la cadence par défaut qu'une cadence devinée.
const TIERS: RefreshTier[] = parseTiers(process.env.CRON_TIERS) ?? DEFAULT_TIERS;
// Cadence du palier le plus fréquent — sert d'étiquette dans le bilan de run.
const UPDATE_INTERVAL_HOURS = TIERS[0].intervalHours;

// Nombre de mangas traités en parallèle.
//
// ⚠️ Ce réglage ne borne PLUS la charge par source : c'est `CRON_SOURCE_CONCURRENCY`
// qui s'en charge désormais. Avant, les deux étaient confondus — 4 séries en vol
// signifiaient au plus 4 requêtes chez chaque source, et on ne pouvait pas monter
// l'un sans monter l'autre. À 8 séries et 4 requêtes/source, les sources voient
// exactement la charge d'hier ; seule l'attente inutile disparaît.
const CRON_CONCURRENCY = Number(process.env.CRON_CONCURRENCY) || 8;
// Requêtes concurrentes tolérées par source. 0 désactive explicitement la limite (et
// rend son réglage au seul `CRON_CONCURRENCY`, comme avant).
//
// ⚠️ Une chaîne VIDE compte comme « non renseigné », pas comme 0 : le workflow passe
// systématiquement la variable, vide sur `schedule`. Un `Number("")` naïf vaudrait 0
// et désactiverait la limite sur tous les runs planifiés — exactement l'inverse du
// but recherché, et en silence.
const CRON_SOURCE_CONCURRENCY = (() => {
  const raw = process.env.CRON_SOURCE_CONCURRENCY?.trim();
  if (!raw) return 4;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 4;
})();
// Petit délai après chaque manga (par worker) pour éviter de marteler les sources.
const BATCH_DELAY = Number(process.env.CRON_BATCH_DELAY) || 300;

// Deadline DOUCE : passé ce budget, le pool arrête de prendre de nouvelles séries et
// le script se termine proprement (timestamps écrits, bilan publié).
//
// ⚠️ Le job GitHub a un `timeout-minutes: 60` qui, lui, est BRUTAL : il tue le process.
// On garde donc une marge confortable en dessous. Une série non traitée reste éligible
// au run suivant — perdre 15 min de scraping est sans conséquence, perdre le bilan et
// les timestamps du run entier ne l'est pas.
const MAX_RUN_MS = Number(process.env.CRON_MAX_RUN_MS) || 45 * 60 * 1000;

// Nombre de succès accumulés avant d'écrire les timestamps en base.
// ⚠️ Ce n'est pas une optimisation, c'est une assurance : cf. `markUpdated`.
const FLUSH_EVERY = Number(process.env.CRON_FLUSH_EVERY) || 200;

// Erreurs consécutives tolérées sur une même source avant de l'écarter pour le reste
// du run (cf. `scraperManager.enableCircuitBreaker`).
const BREAKER_THRESHOLD = Number(process.env.CRON_BREAKER_THRESHOLD) || 10;

// Nombre d'échecs détaillés dans le log final. Au-delà, on ne fait plus que compter :
// le bilan de run et les annotations disent déjà l'essentiel.
const MAX_LOGGED_FAILURES = 20;

/**
 * Exécute `worker` sur chaque élément avec une concurrence bornée (pool de workers).
 * Conserve l'ordre des résultats.
 *
 * `shouldStop` est consulté avant de prendre chaque nouvel élément : les tâches déjà
 * en vol vont au bout, aucune nouvelle n'est lancée. Les éléments jamais pris sont
 * simplement laissés au run suivant, d'où le `processed` renvoyé.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean
): Promise<{ results: R[]; processed: number }> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let processed = 0;

  async function runner() {
    while (true) {
      if (shouldStop?.()) return;
      const index = cursor++;
      if (index >= items.length) return;
      processed++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner()
  );
  await Promise.all(workers);

  // Les index sont distribués séquentiellement depuis 0 : les `processed` premiers
  // sont donc exactement ceux qui ont été traités, et `Promise.all` garantit qu'ils
  // sont tous remplis. Le reste du tableau est laissé au run suivant.
  return { results: results.slice(0, processed), processed };
}

// PostgREST (Supabase) tronque toute réponse à 1000 lignes par défaut — y compris les RPC.
// Toute lecture potentiellement > 1000 lignes DOIT donc être paginée (.range) ou découpée.
const PAGE_SIZE = 1000;
// Taille des lots pour les filtres `.in(...)` : borne la longueur de l'URL générée
// et garantit que chaque réponse tient sous la limite de 1000 lignes.
const IN_CHUNK_SIZE = 500;

/**
 * Récupère TOUS les manga_ids distincts ayant des chapitres, en paginant la RPC.
 * L'ordre `manga_id` rend la pagination par offset déterministe (pas de doublons/trous).
 */
async function fetchAllMangaIdsWithChapters(): Promise<number[]> {
  const ids = new Set<number>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .rpc("get_chapters_unique_manga_ids")
      .order("manga_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch chapters manga ids: ${error.message}`);
    }
    const rows = (data as { manga_id: number }[]) || [];
    rows.forEach((r) => ids.add(r.manga_id));
    if (rows.length < PAGE_SIZE) break;
  }
  return [...ids];
}

interface MangaActivity {
  ids: number[];
  /** Date du dernier chapitre vu, par série. `null` = inconnue ⇒ palier le plus fréquent. */
  lastChapterAt: Map<number, string | null>;
  /** `fallback` = la RPC d'activité n'existe pas encore : cadence uniforme, comme avant. */
  source: "activity" | "fallback";
}

/**
 * Activité de chaque série ayant des chapitres, pour choisir son palier de cadence.
 *
 * ⚠️ Le SQL se déploie indépendamment du code (cf. sql/get_chapters_manga_activity.sql).
 * Tant que la RPC n'existe pas, on retombe sur `get_chapters_unique_manga_ids` et
 * TOUTES les séries héritent du palier le plus fréquent — soit très exactement le
 * comportement d'avant la cadence adaptative. L'ordre de déploiement est donc libre.
 */
async function fetchMangaActivity(): Promise<MangaActivity> {
  const lastChapterAt = new Map<number, string | null>();
  let unavailable = false;

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .rpc("get_chapters_manga_activity")
      .order("manga_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.warn(
        `⚠️ get_chapters_manga_activity unavailable (${error.message}) — falling back to a uniform cadence`
      );
      unavailable = true;
      // Une pagination interrompue à mi-course laisserait une vue partielle : on
      // repart de zéro plutôt que de mélanger deux sources de vérité.
      lastChapterAt.clear();
      break;
    }

    const rows =
      (data as { manga_id: number; last_chapter_at: string | null }[]) || [];
    rows.forEach((row) => lastChapterAt.set(row.manga_id, row.last_chapter_at));
    if (rows.length < PAGE_SIZE) break;
  }

  if (!unavailable) {
    return {
      ids: [...lastChapterAt.keys()],
      lastChapterAt,
      source: "activity",
    };
  }

  const ids = await fetchAllMangaIdsWithChapters();
  ids.forEach((id) => lastChapterAt.set(id, null));
  return { ids, lastChapterAt, source: "fallback" };
}

interface MangaToUpdate {
  id: number;
  mal_id: number;
  title: string;
  title_english: string | null;
  type: string;
  status: string;
  last_chapters_update: string | null;
  title_synonyms: string[] | null;
}

interface UpdateResult {
  manga_id: number;
  title: string;
  success: boolean;
  chapters_found?: number;
  providers_used?: number;
  error?: string;
}

interface RunOutcome {
  success: boolean;
  message: string;
  updated: number;
  total?: number;
  processed?: number;
  skipped_for_deadline?: number;
  total_chapters?: number;
  duration_seconds?: number;
  results?: UpdateResult[];
}

/**
 * Marque un lot de séries comme à jour, par paquets de IN_CHUNK_SIZE ids.
 *
 * ⚠️ Le découpage n'est PAS cosmétique : un `.in()` non borné construit une URL
 * qui grandit avec le catalogue et finit par dépasser la limite de PostgREST.
 * L'échec serait doublement coûteux — aucun timestamp avancé, donc TOUTES les
 * séries re-scrapées au cycle suivant. Même règle que les lectures plus haut.
 */
async function markUpdated(malIds: number[]): Promise<void> {
  if (malIds.length === 0) return;

  // Un horodatage par lot. Anciennement un seul pour tout le run, mais les
  // timestamps sont désormais écrits au fil de l'eau : chaque série porte donc une
  // date plus PROCHE de son scrape réel qu'avant (où toutes portaient la fin du run).
  const updatedAt = new Date().toISOString();

  for (let i = 0; i < malIds.length; i += IN_CHUNK_SIZE) {
    const chunk = malIds.slice(i, i + IN_CHUNK_SIZE);
    const { error } = await supabaseAdmin
      .from("mangas")
      .update({ last_chapters_update: updatedAt })
      .in("mal_id", chunk);

    if (error) {
      console.error(
        `❌ Error batch updating timestamps (ids ${i}-${i + chunk.length - 1}):`,
        error
      );
    }
  }
}

async function updateChapters(): Promise<RunOutcome> {
  try {
    console.log("🔄 Starting chapter update job...");
    const startTime = Date.now();
    const deadline = startTime + MAX_RUN_MS;

    // Collecte des temps par provider — activée ICI seulement : le collecteur est
    // inerte dans l'application (process long, cf. src/lib/scraperStats.ts).
    scraperStats.enable();
    // Idem pour le coupe-circuit : réservé au cron, qui vit le temps d'un run.
    scraperManager.enableCircuitBreaker(BREAKER_THRESHOLD);
    // Idem pour la limite par source : dans l'application, une file d'attente globale
    // ferait patienter des requêtes utilisateur derrière le scraping.
    if (CRON_SOURCE_CONCURRENCY > 0) {
      scraperManager.enableSourceLimits(CRON_SOURCE_CONCURRENCY);
    }
    /** Durée bout en bout de chaque série (succès comme échec), pour la distribution. */
    const mangaDurations: number[] = [];
    /** Coût utile de chaque série (provider le plus lent, hors attente de jeton). */
    const mangaBusyDurations: number[] = [];
    /** Attente d'un jeton de source par série. */
    const mangaWaitDurations: number[] = [];

    // Step 1: Get all distinct manga_ids that have chapters in the database,
    // avec la date de leur dernier chapitre (pour le palier de cadence).
    // ⚠️ Paginé : la RPC est tronquée à 1000 lignes par PostgREST sinon — les séries
    // au-delà de la 1000e n'étaient JAMAIS mises à jour (bug corrigé le 2026-07-19).
    const activity = await fetchMangaActivity();
    const uniqueMangaIds = activity.ids;

    if (uniqueMangaIds.length === 0) {
      console.log("✅ No chapters found in database");
      return {
        success: true,
        message: "No chapters found in database",
        updated: 0,
      };
    }

    console.log(
      `📊 Found ${uniqueMangaIds.length} unique mangas with chapters`
    );

    // Step 2: Get mangas that need update
    // Filtre poussé côté SQL (moins de données transférées, pas de filtrage JS) :
    //   - a des chapitres (mal_id ∈ uniqueMangaIds)
    //   - jamais mis à jour OU dernière mise à jour plus vieille que SON palier
    //   - statut ≠ "Finished" / "Discontinued"
    // Découpé en lots de IN_CHUNK_SIZE ids : borne l'URL du filtre `.in()` et
    // garantit chaque réponse sous la limite de 1000 lignes de PostgREST.
    //
    // Une requête par palier plutôt qu'un filtre unique complexifié : chaque palier a
    // sa propre date de coupure, et le SQL reste celui d'avant.
    const now = Date.now();
    const idsByTier = new Map<RefreshTier, number[]>();
    for (const id of uniqueMangaIds) {
      const tier = tierFor(activity.lastChapterAt.get(id) ?? null, TIERS, now);
      const bucket = idsByTier.get(tier);
      if (bucket) bucket.push(id);
      else idsByTier.set(tier, [id]);
    }

    // En mode `fallback` tout est dans un seul palier : la table n'apprendrait rien.
    const tierBreakdown =
      activity.source === "activity"
        ? TIERS.filter((tier) => idsByTier.has(tier)).map((tier) => ({
            label: tier.label,
            intervalHours: tier.intervalHours,
            candidates: idsByTier.get(tier)?.length ?? 0,
          }))
        : [];

    const mangasNeedingUpdate: MangaToUpdate[] = [];
    for (const [tier, tierIds] of idsByTier) {
      const cutoffTime = new Date(
        now - tier.intervalHours * 60 * 60 * 1000
      ).toISOString();

      for (let i = 0; i < tierIds.length; i += IN_CHUNK_SIZE) {
        const chunk = tierIds.slice(i, i + IN_CHUNK_SIZE);
        const { data: mangasToUpdate, error: fetchError } = await supabaseAdmin
          .from("mangas")
          .select(
            "id, mal_id, title, title_english, type, status, last_chapters_update, title_synonyms"
          )
          .in("mal_id", chunk)
          .not("status", "in", '("Finished","Discontinued")')
          .or(
            `last_chapters_update.is.null,last_chapters_update.lt.${cutoffTime}`
          );

        if (fetchError) {
          console.error("Error fetching mangas:", fetchError);
          throw new Error(`Failed to fetch mangas: ${fetchError.message}`);
        }

        mangasNeedingUpdate.push(...((mangasToUpdate as MangaToUpdate[]) || []));
      }
    }

    // Les plus périmées d'abord (jamais mises à jour en tête). L'ordre venait jusqu'ici
    // du découpage en lots d'ids, donc de rien du tout. Il devient déterminant dès lors
    // que le run peut s'arrêter avant la fin (deadline douce) : ce qui sera laissé au
    // run suivant est alors ce qui a été rafraîchi le plus récemment.
    mangasNeedingUpdate.sort((a, b) => {
      if (a.last_chapters_update === b.last_chapters_update) return 0;
      if (a.last_chapters_update === null) return -1;
      if (b.last_chapters_update === null) return 1;
      return a.last_chapters_update < b.last_chapters_update ? -1 : 1;
    });

    console.log(
      `🔍 Found ${mangasNeedingUpdate.length} mangas needing update (out of ${uniqueMangaIds.length} total with chapters)`
    );

    if (mangasNeedingUpdate.length === 0) {
      console.log("✅ No mangas need updating at this time");
      return {
        success: true,
        message: "No mangas need updating",
        updated: 0,
        total: 0,
      };
    }

    console.log(
      `📚 Processing ${mangasNeedingUpdate.length} mangas (concurrency: ${CRON_CONCURRENCY})...`
    );

    const chapterService = new ChapterService();

    // Tampon des séries mises à jour avec succès, vidé en base tous les FLUSH_EVERY.
    //
    // ⚠️ Pourquoi au fil de l'eau et non à la fin : les timestamps n'étaient écrits
    // qu'après la dernière série. Un dépassement du `timeout-minutes` du job, une
    // annulation ou un OOM et TOUT le travail du run était perdu — aucune série
    // marquée, tout re-scrapé au cycle suivant.
    let pendingMalIds: number[] = [];
    let flushedCount = 0;

    const flush = async (force: boolean) => {
      if (pendingMalIds.length === 0) return;
      if (!force && pendingMalIds.length < FLUSH_EVERY) return;

      // Échange du tampon AVANT tout `await` : JS est mono-thread, deux workers ne
      // peuvent donc pas emporter le même lot.
      const batch = pendingMalIds;
      pendingMalIds = [];
      flushedCount += batch.length;
      await markUpdated(batch);
      console.log(`💾 Marked ${batch.length} series as updated (${flushedCount} so far)`);
    };

    // Traite les mangas via un pool de workers borné plutôt qu'en série :
    // le temps total passe de ~O(N) à ~O(N / concurrence).
    const { results, processed } = await runWithConcurrency<
      MangaToUpdate,
      UpdateResult
    >(
      mangasNeedingUpdate,
      CRON_CONCURRENCY,
      async (manga) => {
        const mangaStartedAt = Date.now();
        try {
          console.log(
            `  Updating chapters for: ${manga.title} (ID: ${manga.mal_id})`
          );

          // Try to update chapters from all providers
          const updatedChapters =
            await chapterService.updateChaptersFromAllProviders(
              manga.mal_id,
              manga.title,
              manga.type,
              manga.mal_id,
              manga.title_synonyms || undefined,
              manga.title_english || undefined
            );

          // updateChaptersFromAllProviders ne throw jamais (catch interne) :
          // un échec doit compter comme tel, sinon le timestamp serait avancé
          // et la panne du scraping masquée jusqu'au prochain cycle.
          // Depuis 2026-08-31, `success: false` couvre aussi le cas « aucune source
          // n'a répondu » — auparavant compté comme un succès à 0 chapitre.
          // Mesuré avant le test de succès : un échec a coûté du temps de scraping
          // lui aussi, et l'omettre fausserait le taux d'occupation à la baisse.
          mangaBusyDurations.push(updatedChapters.busyMs);
          mangaWaitDurations.push(updatedChapters.waitedMs);

          if (!updatedChapters.success) {
            throw new Error(updatedChapters.error || "Scraping failed");
          }

          pendingMalIds.push(manga.mal_id);

          console.log(
            `  ✅ ${manga.title}: ${updatedChapters.totalChaptersAdded} chapters from ${updatedChapters.providers.length} provider(s)`
          );

          await flush(false);

          return {
            manga_id: manga.mal_id,
            title: manga.title,
            success: true,
            chapters_found: updatedChapters.totalChaptersAdded,
            providers_used: updatedChapters.providers.length,
          };
        } catch (error) {
          console.error(`  ❌ Error updating ${manga.title}:`, error);
          return {
            manga_id: manga.mal_id,
            title: manga.title,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        } finally {
          // Mesuré avant le délai de politesse : celui-ci n'est pas du travail utile
          // et fausserait la distribution.
          mangaDurations.push(Date.now() - mangaStartedAt);

          // Petit délai après chaque manga pour rester poli avec les sources amont.
          // ⚠️ Dans le `finally` et non dans le `try` : appliqué au seul chemin de
          // succès, il épargnait précisément la source qui vient d'échouer — donc
          // celle qu'on réinterrogeait le plus vite.
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
        }
      },
      () => Date.now() >= deadline
    );

    // Dernier lot, quoi qu'il arrive.
    await flush(true);

    const skippedForDeadline = mangasNeedingUpdate.length - processed;
    if (skippedForDeadline > 0) {
      console.warn(
        `⏱️ Soft deadline reached: ${skippedForDeadline} series left for the next run`
      );
    }

    const successCount = results.filter((r) => r.success).length;
    const totalChapters = results.reduce(
      (sum, r) => sum + (r.chapters_found || 0),
      0
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(
      `✅ Update job completed in ${duration}s: ${successCount}/${processed} mangas updated, ${totalChapters} chapters total`
    );

    // Bilan lisible du run (cf. writeRunSummary).
    const totalMs = Date.now() - startTime;
    const providers = scraperStats.aggregates();
    const trippedProviders = scraperManager.trippedProviders();

    writeRunSummary(
      buildRunSummary({
        seriesWithChapters: uniqueMangaIds.length,
        needingUpdate: mangasNeedingUpdate.length,
        processed,
        skippedForDeadline,
        succeeded: successCount,
        chaptersWritten: totalChapters,
        totalMs,
        concurrency: CRON_CONCURRENCY,
        batchDelayMs: BATCH_DELAY,
        updateIntervalHours: UPDATE_INTERVAL_HOURS,
        mangaDurations,
        mangaBusyDurations,
        mangaWaitDurations,
        sourceConcurrency: CRON_SOURCE_CONCURRENCY,
        tierBreakdown,
        providers,
        trippedProviders,
      })
    );

    // Annotations GitHub : un bilan que personne n'ouvre n'alerte personne.
    emitAlerts([
      ...buildProviderAlerts(providers),
      ...trippedProviders.map(
        (p) => `${p}: circuit breaker opened — skipped for the rest of the run`
      ),
    ]);

    return {
      success: true,
      message: "Chapter update completed",
      updated: successCount,
      total: mangasNeedingUpdate.length,
      processed,
      skipped_for_deadline: skippedForDeadline,
      total_chapters: totalChapters,
      duration_seconds: parseFloat(duration),
      results,
    };
  } catch (error) {
    console.error("❌ Error in chapter update job:", error);
    throw error;
  }
}

// Point d'entrée : ce fichier n'est jamais importé, uniquement exécuté par le cron.
updateChapters()
  .then(({ results, ...summary }) => {
    // ⚠️ `results` contient une entrée PAR SÉRIE : le sérialiser en entier noyait le
    // log (et se faisait tronquer par GitHub). Le bilan de run porte les agrégats ;
    // ici on ne garde que ce qui n'y figure pas — le détail des échecs.
    console.log("\n📊 Final Result:", JSON.stringify(summary, null, 2));

    const failures = (results ?? []).filter((r) => !r.success);
    if (failures.length > 0) {
      console.log(`\n❌ ${failures.length} série(s) en échec :`);
      for (const failure of failures.slice(0, MAX_LOGGED_FAILURES)) {
        console.log(`  - ${failure.title} (${failure.manga_id}): ${failure.error}`);
      }
      if (failures.length > MAX_LOGGED_FAILURES) {
        console.log(`  … et ${failures.length - MAX_LOGGED_FAILURES} de plus`);
      }
    }

    // 🔴 Seule condition d'échec du job : le run avait du travail et RIEN n'a abouti.
    // Volontairement binaire — le workflow se déclenche 48 fois par jour, une alerte
    // qui crie pour une dégradation partielle serait coupée en une semaine. Les
    // dégradations passent par les annotations `::warning::` (cf. `emitAlerts`).
    const totalFailure = (summary.processed ?? 0) > 0 && summary.updated === 0;
    if (totalFailure) {
      console.error(
        "\n❌ No series could be updated at all — failing the job so someone looks."
      );
      process.exit(1);
    }

    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  });

export { updateChapters };

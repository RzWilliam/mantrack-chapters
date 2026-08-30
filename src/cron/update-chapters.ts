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

const UPDATE_INTERVAL_HOURS = 2; // Update every 2 hours
// Nombre de mangas traités en parallèle. Chaque manga interroge déjà tous ses providers
// en parallèle (scrapeWithAllProviders) : on garde donc une concurrence modérée pour
// rester poli avec les sources amont tout en réduisant fortement le temps total.
const CRON_CONCURRENCY = Number(process.env.CRON_CONCURRENCY) || 4;
// Petit délai après chaque manga (par worker) pour éviter de marteler les sources.
const BATCH_DELAY = Number(process.env.CRON_BATCH_DELAY) || 300;

/**
 * Exécute `worker` sur chaque élément avec une concurrence bornée (pool de workers).
 * Conserve l'ordre des résultats.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner()
  );
  await Promise.all(workers);
  return results;
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

async function updateChapters() {
  try {
    console.log("🔄 Starting chapter update job...");
    const startTime = Date.now();

    // Step 1: Get all distinct manga_ids that have chapters in the database
    // ⚠️ Paginé : la RPC est tronquée à 1000 lignes par PostgREST sinon — les séries
    // au-delà de la 1000e n'étaient JAMAIS mises à jour (bug corrigé le 2026-07-19).
    const uniqueMangaIds = await fetchAllMangaIdsWithChapters();

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
    //   - jamais mis à jour OU dernière mise à jour > 2h
    //   - statut ≠ "Finished" / "Discontinued"
    // Découpé en lots de IN_CHUNK_SIZE ids : borne l'URL du filtre `.in()` et
    // garantit chaque réponse sous la limite de 1000 lignes de PostgREST.
    const cutoffTime = new Date(
      Date.now() - UPDATE_INTERVAL_HOURS * 60 * 60 * 1000
    ).toISOString();

    const mangasNeedingUpdate: MangaToUpdate[] = [];
    for (let i = 0; i < uniqueMangaIds.length; i += IN_CHUNK_SIZE) {
      const chunk = uniqueMangaIds.slice(i, i + IN_CHUNK_SIZE);
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
    const successfulMalIds: number[] = [];

    // Traite les mangas via un pool de workers borné plutôt qu'en série :
    // le temps total passe de ~O(N) à ~O(N / concurrence).
    const results: UpdateResult[] = await runWithConcurrency(
      mangasNeedingUpdate,
      CRON_CONCURRENCY,
      async (manga) => {
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
          if (!updatedChapters.success) {
            throw new Error(updatedChapters.error || "Scraping failed");
          }

          successfulMalIds.push(manga.mal_id);

          console.log(
            `  ✅ ${manga.title}: ${updatedChapters.totalChaptersAdded} chapters from ${updatedChapters.providers.length} provider(s)`
          );

          // Petit délai après chaque manga pour rester poli avec les sources amont.
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));

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
        }
      }
    );

    // Marque les séries traitées avec succès, par lots de IN_CHUNK_SIZE ids.
    // ⚠️ Le découpage n'est PAS cosmétique : un `.in()` non borné construit une URL
    // qui grandit avec le catalogue et finit par dépasser la limite de PostgREST.
    // L'échec serait doublement coûteux — aucun timestamp avancé, donc TOUTES les
    // séries re-scrapées au cycle suivant. Même règle que les lectures plus haut.
    if (successfulMalIds.length > 0) {
      // Un seul horodatage pour tous les lots : sinon deux séries du même run
      // porteraient des dates différentes sans raison.
      const updatedAt = new Date().toISOString();

      for (let i = 0; i < successfulMalIds.length; i += IN_CHUNK_SIZE) {
        const chunk = successfulMalIds.slice(i, i + IN_CHUNK_SIZE);
        const { error: batchUpdateError } = await supabaseAdmin
          .from("mangas")
          .update({ last_chapters_update: updatedAt })
          .in("mal_id", chunk);

        if (batchUpdateError) {
          console.error(
            `❌ Error batch updating timestamps (ids ${i}-${
              i + chunk.length - 1
            }):`,
            batchUpdateError
          );
        }
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const totalChapters = results.reduce(
      (sum, r) => sum + (r.chapters_found || 0),
      0
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(
      `✅ Update job completed in ${duration}s: ${successCount}/${mangasNeedingUpdate.length} mangas updated, ${totalChapters} chapters total`
    );

    return {
      success: true,
      message: "Chapter update completed",
      updated: successCount,
      total: mangasNeedingUpdate.length,
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
  .then((result) => {
    console.log("\n📊 Final Result:", JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  });

export { updateChapters };

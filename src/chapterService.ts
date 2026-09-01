import { supabase } from "./lib/supabase";
import { supabaseAdmin } from "./lib/supabaseAdmin";
import {
  Chapter,
  ChapterWithProvider,
  Provider,
  ScrapedChapter,
} from "./types";
import { scraperManager, type ProviderError } from "./scrapers/scraperManager";
import { selectChaptersToUpsert } from "./lib/chapterDelta";

/**
 * Nombre de chapitres les plus récents systématiquement réécrits, même déjà en base
 * (cf. `selectChaptersToUpsert`). Ne couvre plus que `release_date` : les révisions de
 * `link` sont désormais détectées par comparaison, à n'importe quelle profondeur.
 */
const CHAPTER_REFRESH_WINDOW = Number(process.env.CHAPTER_REFRESH_WINDOW) || 5;

/**
 * Écriture en delta. Trappe de sortie volontaire : `CHAPTER_DELTA_UPSERT=0` restaure
 * la réécriture intégrale d'avant, sans redéploiement de code.
 */
const DELTA_UPSERT_ENABLED = !["0", "false", "no"].includes(
  (process.env.CHAPTER_DELTA_UPSERT ?? "").toLowerCase()
);

/** PostgREST tronque à 1000 lignes : la lecture des numéros existants DOIT paginer. */
const CHAPTER_PAGE_SIZE = 1000;

export interface LatestChapterProvider {
  provider_name: string;
  chapter_url: string;
  /** Dernier chapitre de la série disponible chez ce provider (fenêtre récente). */
  chapter_number: number;
}

export interface LatestChapterCard {
  mal_id: number;
  title: string;
  image_url: string | null;
  chapter_number: number;
  /** Date d'affichage : date d'ajout en base du chapitre (created_at). */
  created_at: string;
  providers: LatestChapterProvider[];
}

export class ChapterService {
  /**
   * Get all providers
   */
  async getProviders(): Promise<Provider[]> {
    const { data, error } = await supabase
      .from("providers")
      .select("*")
      .order("name");

    if (error) {
      console.error("Error fetching providers:", error);
      return [];
    }

    return data || [];
  }

  /**
   * Get chapters for a specific manga
   */
  async getChaptersForManga(
    mangaId: number,
    page = 1,
    limit = 50
  ): Promise<{
    chapters: ChapterWithProvider[];
    total: number;
  }> {
    const offset = (page - 1) * limit;

    const {
      data: chapters,
      error: chaptersError,
      count,
    } = await supabase
      .from("chapters")
      .select(
        `
        *,
        provider:providers!inner(*)
      `,
        { count: "exact" }
      )
      .eq("manga_id", mangaId)
      .eq("provider.enabled", true)
      .order("chapter_number", { ascending: false })
      .range(offset, offset + limit - 1);

    if (chaptersError) {
      console.error("Error fetching chapters:", chaptersError);
      return { chapters: [], total: 0 };
    }

    return {
      chapters: chapters || [],
      total: count || 0,
    };
  }

  /**
   * Derniers chapitres sortis, toutes séries confondues, pour la section
   * « Latest chapters » de la home. On récupère les N SÉRIES distinctes via la RPC
   * `get_latest_chapters_across_series` (1 ligne/série : le chapitre au n° le plus
   * élevé, daté par sa 1re apparition, séries triées par cette date — cf.
   * sql/get_latest_chapters_across_series.sql), puis on ré-interroge tous les
   * providers de leur dernier chapitre (→ providers[]) et on enrichit avec les
   * métadonnées. Résultat mis en cache 5 min (perf).
   *
   * ⚠️ Anciennement : fenêtre fixe des 200 chapitres les plus récents PUIS
   *    regroupement JS → une série qui intègre tous ses chapitres d'un coup
   *    saturait la fenêtre et évinçait les autres séries (~18 cartes → 3-4). La
   *    RPC (1 ligne par série) rend le classement insensible à la taille des dumps.
   */
  /**
   * Lookup batché titre/couverture pour les cartes « derniers chapitres ».
   * Reprend à l'identique la requête de `LocalMangaService.getMangasByIds`
   * (client anon, données publiques) — cf. commentaire dans la méthode appelante.
   */
  private async getMangaCardsByMalIds(
    ids: number[]
  ): Promise<{ mal_id: number; title: string; image_url: string | null }[]> {
    if (!ids.length) return [];

    const { data, error } = await supabase
      .from("mangas")
      .select("id, mal_id, title, image_url, score")
      .in("mal_id", ids);

    if (error) {
      console.error("Error fetching mangas by ids:", error);
      return [];
    }

    return (data || []) as unknown as {
      mal_id: number;
      title: string;
      image_url: string | null;
    }[];
  }

  async getLatestChaptersAcrossSeries(limit = 18): Promise<LatestChapterCard[]> {
    const cacheKey = `home:latest_chapters:limit:${limit}`;
    // Cache long « dernier bon résultat » : sert de filet si la requête échoue
    // (timeout Postgres) pour ne pas faire disparaître la section.
    const lastGoodKey = `home:latest_chapters:last_good:${limit}`;
    let searchCache: (typeof import("./lib/simpleCache"))["searchCache"] | null =
      null;
    try {
      ({ searchCache } = await import("./lib/simpleCache"));
      const cached = searchCache.get(cacheKey) as LatestChapterCard[] | null;
      if (cached) return cached;
    } catch {
      /* ignore cache import errors */
    }

    // 1. Les N séries distinctes les plus récentes (1 ligne/série côté Postgres,
    //    déjà triée et limitée). Par série la RPC garde le chapitre au NUMÉRO le plus
    //    élevé (le vrai dernier, insensible aux back-fills d'anciens chapitres) et le
    //    date par sa 1re apparition (created_at le plus ANCIEN de ses providers).
    //    `created_at` renvoyé = cette date de 1re apparition → sert au classement ET,
    //    plus bas, à l'affichage (l'étape 3 la recalcule à l'identique via `oldest`).
    //    Insensible aux dumps : une série qui insère N chapitres d'un coup ne pèse
    //    qu'une ligne. supabaseAdmin (serveur only) : la RPC tourne en service-role.
    type RankedRow = {
      manga_id: number;
      chapter_number: number;
      created_at: string;
    };
    const { data: rankedRows, error } = await supabaseAdmin.rpc(
      "get_latest_chapters_across_series",
      { p_limit: limit }
    );

    if (error) {
      console.error("Error fetching latest chapters across series:", error);
      // Dégradation gracieuse : servir le dernier résultat connu plutôt que
      // masquer la section sur un simple timeout.
      const lastGood = searchCache?.get(lastGoodKey) as
        | LatestChapterCard[]
        | null;
      return lastGood ?? [];
    }

    // 2. Normaliser vers la forme attendue par les étapes 3-4 (mal_id, chapter_number,
    //    recency). L'ordre (récence DESC) et la limite sont déjà appliqués par la RPC.
    const ranked = ((rankedRows || []) as RankedRow[]).map((r) => ({
      mal_id: r.manga_id,
      chapter_number: r.chapter_number,
      recency: r.created_at,
    }));
    if (ranked.length === 0) return [];

    // 3. Récupérer TOUS les providers du dernier chapitre de chaque série retenue.
    //    La RPC (étape 1) ne renvoie qu'une ligne par série → un seul provider ; il
    //    faut donc ré-interroger pour reconstituer providers[] (→ modal multi-sources).
    //    Requête ciblée (OR sur (manga_id, chapter_number)) : bornée à ~séries × providers.
    type LatestRow = {
      manga_id: number;
      chapter_number: number;
      created_at: string;
      link: string;
      provider: { name: string };
    };
    const orFilter = ranked
      .map((s) => `and(manga_id.eq.${s.mal_id},chapter_number.eq.${s.chapter_number})`)
      .join(",");
    const { data: provRows, error: provErr } = await supabaseAdmin
      .from("chapters")
      .select(
        `manga_id, chapter_number, created_at, link, provider:providers!inner(name)`
      )
      .eq("provider.enabled", true)
      .or(orFilter);

    if (provErr) {
      console.error("Error fetching providers for latest chapters:", provErr);
      const lastGood = searchCache?.get(lastGoodKey) as
        | LatestChapterCard[]
        | null;
      return lastGood ?? [];
    }

    // Agréger par série : providers[] (dédup par nom) + date d'affichage = la plus
    // ANCIENNE (première source à sortir le chapitre), comme demandé.
    type Agg = {
      chapter_number: number;
      oldest: string;
      providers: Map<string, LatestChapterProvider>;
    };
    const bySeries = new Map<number, Agg>();
    for (const ch of (provRows || []) as unknown as LatestRow[]) {
      let a = bySeries.get(ch.manga_id);
      if (!a) {
        a = {
          chapter_number: ch.chapter_number,
          oldest: ch.created_at,
          providers: new Map(),
        };
        bySeries.set(ch.manga_id, a);
      }
      if (ch.created_at < a.oldest) a.oldest = ch.created_at;
      if (!a.providers.has(ch.provider.name)) {
        a.providers.set(ch.provider.name, {
          provider_name: ch.provider.name,
          chapter_url: ch.link,
          chapter_number: ch.chapter_number,
        });
      }
    }

    // 4. Enrichir titre + couverture via lookup batché (Task 1). On conserve l'ordre
    //    de `ranked` (récence).
    //    ⚠️ Ce lookup passait par `LocalMangaService.getMangasByIds` avant l'extraction
    //    du package (2026-08-29). La requête est reproduite telle quelle ici pour ne pas
    //    faire dépendre la couche scrapers de la couche métadonnées, restée côté app.
    const metas = await this.getMangaCardsByMalIds(ranked.map((s) => s.mal_id));
    const metaById = new Map(metas.map((m) => [m.mal_id, m]));

    const cards: LatestChapterCard[] = ranked
      .map((s): LatestChapterCard | null => {
        const meta = metaById.get(s.mal_id);
        const agg = bySeries.get(s.mal_id);
        if (!meta || !agg) return null;
        return {
          mal_id: s.mal_id,
          title: meta.title,
          image_url: meta.image_url ?? null,
          chapter_number: agg.chapter_number,
          created_at: agg.oldest,
          // Tri stable des providers par nom (comme Chapters.tsx).
          providers: [...agg.providers.values()].sort((a, b) =>
            a.provider_name.localeCompare(b.provider_name)
          ),
        };
      })
      .filter((c): c is LatestChapterCard => c !== null);

    // Cache court (rendu ISR) + cache long « dernier bon résultat » (filet anti-timeout).
    if (cards.length > 0) {
      searchCache?.set(cacheKey, cards, 5 * 60 * 1000);
      searchCache?.set(lastGoodKey, cards, 24 * 60 * 60 * 1000);
    }

    return cards;
  }

  /**
   * Get first and last chapter information for Quick Navigation
   */
  async getFirstLastChapters(mangaId: number) {
    try {
      // Run both boundary queries in parallel instead of sequentially
      const [firstChapterResult, lastChapterResult] = await Promise.all([
        supabaseAdmin
          .from("chapters")
          .select("chapter_number, provider:providers!inner(enabled)")
          .eq("manga_id", mangaId)
          .eq("provider.enabled", true)
          .order("chapter_number", { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabaseAdmin
          .from("chapters")
          .select("chapter_number, provider:providers!inner(enabled)")
          .eq("manga_id", mangaId)
          .eq("provider.enabled", true)
          .order("chapter_number", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const firstChapterData = firstChapterResult.data;
      const lastChapterData = lastChapterResult.data;

      if (!firstChapterData || !lastChapterData) {
        return { firstChapter: null, lastChapter: null };
      }

      const [firstChapters, lastChapters] = await Promise.all([
        supabaseAdmin
          .from("chapters")
          .select("*, provider:providers!inner(*)")
          .eq("manga_id", mangaId)
          .eq("chapter_number", firstChapterData.chapter_number)
          .eq("provider.enabled", true),
        supabaseAdmin
          .from("chapters")
          .select("*, provider:providers!inner(*)")
          .eq("manga_id", mangaId)
          .eq("chapter_number", lastChapterData.chapter_number)
          .eq("provider.enabled", true),
      ]);

      return {
        firstChapter:
          firstChapters.data?.sort(
            (a, b) =>
              a.provider?.name?.localeCompare(b.provider?.name || "") || 0
          ) || null,
        lastChapter:
          lastChapters.data?.sort(
            (a, b) =>
              a.provider?.name?.localeCompare(b.provider?.name || "") || 0
          ) || null,
      };
    } catch (error) {
      console.error("Error fetching first/last chapters:", error);
      return { firstChapter: null, lastChapter: null };
    }
  }

  /**
   * Save scraped chapters to database
   * Uses upsert to insert new chapters or update existing ones
   * IMPORTANT: This preserves created_at for existing chapters - only link and release_date may be updated
   */
  async saveChapters(
    mangaId: number,
    providerId: string,
    scrapedChapters: ScrapedChapter[]
  ): Promise<Chapter[]> {
    if (scrapedChapters.length === 0) {
      return [];
    }

    // ⚠️ Anciennement : aucun SELECT préalable, on ré-upsertait TOUT l'historique à
    // chaque passage — ~150 lignes × 6 sources × 12 runs/jour, plus autant
    // d'exécutions du trigger `update_chapters_updated_at`, pour typiquement zéro
    // ou un chapitre nouveau. Un SELECT coûte infiniment moins que 150 réécritures.
    //
    // On lit le lien en plus du numéro : c'est ce qui permet de réparer un lien
    // révisé sur un chapitre ancien, que la fenêtre de rafraîchissement ne voyait
    // jamais. Le surcoût est en octets sur un SELECT déjà émis — mêmes lignes, même
    // index — et il est plus que compensé côté écriture, la fenêtre ne réécrivant
    // plus 5 lignes par source à chaque run pour rien. Cf. `selectChaptersToUpsert`.
    const existing = await this.fetchExistingChapters(mangaId, providerId);

    const { toUpsert, skipped, relinked } = existing
      ? selectChaptersToUpsert(
          scrapedChapters,
          existing,
          CHAPTER_REFRESH_WINDOW
        )
      : { toUpsert: scrapedChapters, skipped: 0, relinked: 0 };

    if (skipped > 0) {
      console.log(
        `  ↩︎ ${skipped}/${scrapedChapters.length} chapters already stored and unchanged — not rewritten`
      );
    }

    // ⚠️ À surveiller : un chiffre non nul run après run sur les mêmes séries ne
    // signifie pas « la source corrige ses liens », mais « la source produit des URL
    // instables » — auquel cas la comparaison ne converge jamais.
    if (relinked > 0) {
      console.log(
        `  🔗 ${relinked} chapter(s) rewritten because the source changed their link`
      );
    }

    if (toUpsert.length === 0) {
      return [];
    }

    const chaptersToUpsert = toUpsert.map((chapter) => ({
      chapter_number: chapter.chapter_number,
      link: chapter.link,
      release_date: chapter.release_date,
      provider_id: providerId,
      manga_id: mangaId,
    }));

    // Use upsert with ignoreDuplicates: false to update existing chapters
    // This will INSERT new rows or UPDATE existing ones based on the unique constraint
    //
    // How timestamps are handled:
    // - created_at: PRESERVED for existing rows (not in upsert data, keeps original value)
    // - updated_at: AUTO-UPDATED by database trigger (update_chapters_updated_at)
    //
    // What gets updated for existing chapters:
    // - link: May change if provider changes the URL
    // - release_date: May be updated if provider has more accurate data
    const { data, error } = await supabaseAdmin
      .from("chapters")
      .upsert(chaptersToUpsert, {
        onConflict: "provider_id,manga_id,chapter_number",
        ignoreDuplicates: false, // Update existing chapters if link or release_date changed
      })
      .select();

    if (error) {
      console.error("Error saving chapters:", error);
      return [];
    }

    return data || [];
  }

  /**
   * Lien déjà stocké, par numéro de chapitre, pour un couple (série, source).
   *
   * Renvoie `null` quand on ne peut pas savoir — écriture en delta désactivée, ou
   * lecture en échec. L'appelant retombe alors sur la réécriture intégrale : en cas
   * de doute on écrit trop, jamais trop peu.
   */
  private async fetchExistingChapters(
    mangaId: number,
    providerId: string
  ): Promise<Map<number, string | null> | null> {
    if (!DELTA_UPSERT_ENABLED) return null;

    const stored = new Map<number, string | null>();

    // ⚠️ Paginé : une série de plus de 1000 chapitres (One Piece & co.) verrait
    // sinon sa liste tronquée, et les chapitres au-delà seraient réécrits à chaque
    // run — le bug qu'on croirait avoir corrigé.
    for (let from = 0; ; from += CHAPTER_PAGE_SIZE) {
      const { data, error } = await supabaseAdmin
        .from("chapters")
        .select("chapter_number, link")
        .eq("manga_id", mangaId)
        .eq("provider_id", providerId)
        .order("chapter_number", { ascending: true })
        .range(from, from + CHAPTER_PAGE_SIZE - 1);

      if (error) {
        console.warn(
          "Could not read existing chapters, falling back to a full upsert:",
          error.message
        );
        return null;
      }

      const rows = (data || []) as { chapter_number: number; link: string | null }[];
      rows.forEach((row) => stored.set(row.chapter_number, row.link));
      if (rows.length < CHAPTER_PAGE_SIZE) break;
    }

    return stored;
  }

  /**
   * Get AsuraComic provider
   */
  async getAsuraComicProvider(): Promise<Provider | null> {
    const { data, error } = await supabase
      .from("providers")
      .select("*")
      .eq("name", "Asura")
      .single();

    if (error) {
      console.error("Error fetching Asura provider:", error);
      return null;
    }

    return data;
  }

  /**
   * Cache mémoire des providers (nom → ligne `providers`), partagé par toutes
   * les instances (`static`) : le cron en construit une, l'app importe le
   * singleton exporté en bas de fichier.
   *
   * ⚠️ Pourquoi : `getOrCreateProvider` est appelé pour CHAQUE couple
   * (série × provider) dans `updateChaptersFromAllProviders` — soit des milliers
   * d'allers-retours Supabase par run de cron, pour relire les 6 mêmes lignes,
   * constantes. On mémorise la PROMESSE et non la valeur, afin que les workers
   * concurrents partagent une seule requête au lieu d'en lancer une chacun.
   *
   * Durée de vie = celle du process. Un provider ajouté ou renommé en base n'est
   * donc vu qu'au run suivant : sans effet ici, la table ne bouge quasiment jamais
   * (l'activation/désactivation, elle, passe par `scraperManager.syncWithDatabase`).
   */
  private static readonly providerCache = new Map<string, Promise<Provider>>();

  /**
   * Get or create a provider (mémoïsé — cf. `providerCache`)
   */
  async getOrCreateProvider(name: string, baseUrl: string): Promise<Provider> {
    const cached = ChapterService.providerCache.get(name);
    if (cached) return cached;

    const pending = this.fetchOrCreateProvider(name, baseUrl).catch((error) => {
      // Un échec transitoire ne doit pas rester en cache pour tout le run :
      // on vide l'entrée pour que le prochain appel retente.
      ChapterService.providerCache.delete(name);
      throw error;
    });

    ChapterService.providerCache.set(name, pending);
    return pending;
  }

  /** Lecture (ou création) réelle en base, derrière le cache. */
  private async fetchOrCreateProvider(
    name: string,
    baseUrl: string
  ): Promise<Provider> {
    // Chercher le provider existant (lecture publique OK)
    const { data: existingProvider } = await supabase
      .from("providers")
      .select("*")
      .eq("name", name)
      .single();

    if (existingProvider) {
      return existingProvider;
    }

    // Créer un nouveau provider avec supabaseAdmin (bypass RLS)
    const { data: newProvider, error } = await supabaseAdmin
      .from("providers")
      .insert({
        name,
        base_url: baseUrl,
      })
      .select()
      .single();

    if (error) {
      console.error("Error creating provider:", error);
      throw error;
    }

    return newProvider;
  }

  /**
   * Update chapters for a manga from AsuraComic using the scraper manager
   */
  async updateChaptersFromAsuraComic(
    mangaId: number,
    mangaTitle: string
  ): Promise<{
    success: boolean;
    chaptersAdded: number;
    error?: string;
  }> {
    try {
      console.log(`Updating chapters for: ${mangaTitle}`);

      // Obtenir ou créer le provider AsuraComic
      const provider = await this.getOrCreateProvider(
        "Asura",
        "https://asurascans.com"
      );

      // Utiliser le scraper manager pour récupérer les chapitres
      const scrapedChapters = await scraperManager.scrapeWithProvider(
        "Asura",
        mangaTitle
      );

      if (scrapedChapters.length === 0) {
        console.log("No chapters found");
        return { success: true, chaptersAdded: 0 };
      }

      console.log(`Found ${scrapedChapters.length} chapters`);

      // Sauvegarder les chapitres
      const savedChapters = await this.saveChapters(
        mangaId,
        provider.id,
        scrapedChapters
      );

      return {
        success: true,
        chaptersAdded: savedChapters.length,
      };
    } catch (error) {
      console.error("Error updating chapters from AsuraComic:", error);
      return {
        success: false,
        chaptersAdded: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update chapters for a manga using any available provider
   */
  async updateChaptersFromAnyProvider(
    mangaId: number,
    mangaTitle: string,
    mangaType?: string,
    malId?: number,
    titleSynonyms?: string[]
  ): Promise<{
    success: boolean;
    chaptersAdded: number;
    provider?: string;
    error?: string;
  }> {
    try {
      console.log(
        `Updating chapters for: ${mangaTitle} (type: ${
          mangaType || "unknown"
        })${malId ? ` (MAL ID: ${malId})` : ""}`
      );

      // Utiliser le scraper manager avec priorisation par type
      const { chapters: scrapedChapters, provider: foundProvider } =
        await scraperManager.scrapeByMangaType(
          mangaTitle,
          mangaType,
          malId,
          titleSynonyms
        );

      if (scrapedChapters.length === 0) {
        console.log("No chapters found with any provider");
        return { success: true, chaptersAdded: 0 };
      }

      console.log(
        `Found ${scrapedChapters.length} chapters using ${foundProvider}`
      );

      // Obtenir ou créer le provider
      const scraperConfig = scraperManager.getScraperConfig(foundProvider);
      if (!scraperConfig) {
        throw new Error(`Provider config not found for: ${foundProvider}`);
      }

      const provider = await this.getOrCreateProvider(
        foundProvider,
        scraperConfig.baseUrl
      );

      // Sauvegarder les chapitres
      const savedChapters = await this.saveChapters(
        mangaId,
        provider.id,
        scrapedChapters
      );

      return {
        success: true,
        chaptersAdded: savedChapters.length,
        provider: foundProvider,
      };
    } catch (error) {
      console.error("Error updating chapters from any provider:", error);
      return {
        success: false,
        chaptersAdded: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check if chapters exist for a manga
   */
  async hasChapters(mangaId: number): Promise<boolean> {
    const { count, error } = await supabase
      .from("chapters")
      .select("*", { count: "exact", head: true })
      .eq("manga_id", mangaId);

    if (error) {
      console.error("Error checking chapters:", error);
      return false;
    }

    return (count || 0) > 0;
  }

  /**
   * Get latest chapter for a manga
   */
  async getLatestChapter(mangaId: number): Promise<ChapterWithProvider | null> {
    const { data, error } = await supabase
      .from("chapters")
      .select(
        `
        *,
        provider:providers(*)
      `
      )
      .eq("manga_id", mangaId)
      .order("chapter_number", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      console.error("Error fetching latest chapter:", error);
      return null;
    }

    return data;
  }

  /**
   * Get available scrapers from scraper manager
   */
  getAvailableScrapers() {
    return scraperManager.getAvailableScrapers();
  }

  /**
   * Get enabled scrapers
   */
  async getEnabledScrapers() {
    return await scraperManager.getEnabledScrapers();
  }

  /**
   * Toggle a scraper on/off (in-memory only, use API route for persistence)
   */
  toggleScraper(providerName: string, enabled: boolean): boolean {
    return scraperManager.toggleScraper(providerName, enabled);
  }

  /**
   * Update chapters for a manga using ALL available providers (multiple providers)
   */
  async updateChaptersFromAllProviders(
    mangaId: number,
    mangaTitle: string,
    mangaType?: string,
    malId?: number,
    titleSynonyms?: string[],
    titleEnglish?: string
  ): Promise<{
    success: boolean;
    totalChaptersAdded: number;
    providers: Array<{
      provider: string;
      chaptersAdded: number;
    }>;
    /** Sources en échec pour cette série. Champ additif : les appelants historiques l'ignorent. */
    errors: ProviderError[];
    /** Coût irréductible de la série (provider le plus lent, hors attente de jeton). */
    busyMs: number;
    /** Plus longue attente d'un jeton de source sur cette série. */
    waitedMs: number;
    error?: string;
  }> {
    try {
      console.log(
        `Updating chapters for: ${mangaTitle} (type: ${
          mangaType || "unknown"
        })${malId ? ` (MAL ID: ${malId})` : ""} - ALL PROVIDERS MODE`
      );

      // Utiliser le scraper manager pour essayer TOUS les providers
      const { results, errors, attempted, skipped, busyMs, waitedMs } =
        await scraperManager.scrapeWithAllProviders(
          mangaTitle,
          mangaType,
          malId,
          titleSynonyms,
          titleEnglish
        );

      // 🔴 « Aucun chapitre » ne vaut PAS « échec » : une série peut être légitimement
      // absente de toutes les sources, et la déclarer en échec la ferait re-scraper à
      // chaque run indéfiniment. Le critère est donc « au moins une source a répondu
      // sans lever d'erreur », pas « au moins un chapitre trouvé ».
      //
      // ⚠️ Avant (2026-08-31), ce cas renvoyait `success: true` quoi qu'il arrive : une
      // série dont les 6 sources avaient échoué avançait son `last_chapters_update` et
      // s'affichait en vert dans le bilan de run. Une panne totale du scraping restait
      // donc invisible jusqu'au cycle suivant — c'est précisément ce que le contrat
      // d'erreur des scrapers (cf. `scrapers/types.ts`) sert à empêcher.
      const answered = attempted - errors.length;
      if (answered === 0 && (attempted > 0 || skipped.length > 0)) {
        const detail = errors.length
          ? errors.map((e) => `${e.provider}: ${e.message}`).join(" | ")
          : `all compatible providers tripped (${skipped.join(", ")})`;
        console.error(
          `✗ No provider answered for ${mangaTitle} (${attempted} attempted, ${skipped.length} skipped)`
        );
        return {
          success: false,
          totalChaptersAdded: 0,
          providers: [],
          errors,
          busyMs,
          waitedMs,
          error: `No provider answered — ${detail}`,
        };
      }

      if (results.length === 0) {
        console.log("No chapters found with any provider");
        return {
          success: true,
          totalChaptersAdded: 0,
          providers: [],
          errors,
          busyMs,
          waitedMs,
        };
      }

      const providerResults: Array<{
        provider: string;
        chaptersAdded: number;
      }> = [];
      let totalAdded = 0;

      // Sauvegarder les chapitres de chaque provider
      for (const result of results) {
        const { chapters: scrapedChapters, provider: foundProvider } = result;

        console.log(
          `Processing ${scrapedChapters.length} chapters from ${foundProvider}`
        );

        // Obtenir ou créer le provider
        const scraperConfig = scraperManager.getScraperConfig(foundProvider);
        if (!scraperConfig) {
          console.warn(`Provider config not found for: ${foundProvider}`);
          continue;
        }

        const provider = await this.getOrCreateProvider(
          foundProvider,
          scraperConfig.baseUrl
        );

        // Sauvegarder les chapitres
        const savedChapters = await this.saveChapters(
          mangaId,
          provider.id,
          scrapedChapters
        );

        providerResults.push({
          provider: foundProvider,
          chaptersAdded: savedChapters.length,
        });

        totalAdded += savedChapters.length;
      }

      console.log(
        `✓ Total: ${totalAdded} chapters added from ${providerResults.length} provider(s)`
      );

      return {
        success: true,
        totalChaptersAdded: totalAdded,
        providers: providerResults,
        errors,
        busyMs,
        waitedMs,
      };
    } catch (error) {
      console.error("Error updating chapters from all providers:", error);
      return {
        success: false,
        totalChaptersAdded: 0,
        providers: [],
        errors: [],
        busyMs: 0,
        waitedMs: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

export const chapterService = new ChapterService();

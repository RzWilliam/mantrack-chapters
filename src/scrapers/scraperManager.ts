import { ScrapedChapter } from "../types";
import { MangaScraper, ScraperConfig } from './types';
import { asuraComicScraper } from './asuraComicScraper';
import { mangadexScraper } from './mangadexScraper';
import { mangaParkScraper } from './mangaParkScraper';
import { mangaPillScraper } from './mangaPillScraper';
import { weebCentralScraper } from './weebCentralScraper';
import { mangaKatanaScraper } from './mangaKatanaScraper';
import { rokariComicsScraper } from './wpComicScraper';
import { supabase } from "../lib/supabase";
import { scraperStats } from "../lib/scraperStats";
import { Semaphore } from "../lib/semaphore";

/** Une source qui a levé une exception pendant le scrape d'une série. */
export interface ProviderError {
  provider: string;
  message: string;
}

/**
 * Résultat de `scrapeWithAllProviders` pour UNE série.
 *
 * `attempted === errors.length` ⇒ aucune source n'a répondu : on n'a rien appris.
 * `skipped` non vide avec `attempted === 0` ⇒ idem, tout était coupé.
 * Dans les deux cas l'appelant ne doit PAS déclarer un succès.
 */
export interface AllProvidersOutcome {
  results: Array<{ chapters: ScrapedChapter[]; provider: string }>;
  /** Sources ayant levé une exception (cf. contrat d'erreur dans `scrapers/types.ts`). */
  errors: ProviderError[];
  /** Nombre de sources réellement interrogées pour cette série. */
  attempted: number;
  /** Sources écartées d'office par le coupe-circuit. */
  skipped: string[];
  /**
   * Coût IRRÉDUCTIBLE de la série : le plus lent de ses providers, attente d'un jeton
   * EXCLUE (ils tournent tous en parallèle). C'est ce qu'il faut compter comme du
   * scraping — le temps passé en file n'en est pas.
   */
  busyMs: number;
  /** Plus longue attente d'un jeton de source sur cette série. 0 sans limite par source. */
  waitedMs: number;
}

/**
 * Manager pour gérer tous les scrapers de manga
 */
export class ScraperManager {
  private scrapers: Map<string, MangaScraper> = new Map();
  private configs: Map<string, ScraperConfig> = new Map();
  private initialized: boolean = false;

  /** Synchro DB en cours, partagée par tous les appelants concurrents (cf. `ensureInitialized`). */
  private syncPromise: Promise<void> | null = null;
  /** Date avant laquelle on ne retente pas une synchro qui vient d'échouer. */
  private nextSyncRetryAt = 0;
  private static readonly SYNC_RETRY_COOLDOWN_MS = 60_000;

  /** État du coupe-circuit par source. `null` = désactivé (cf. `enableCircuitBreaker`). */
  private breaker: {
    threshold: number;
    consecutiveErrors: Map<string, number>;
    tripped: Set<string>;
  } | null = null;

  /** Limite de concurrence PAR SOURCE. `null` = désactivée (cf. `enableSourceLimits`). */
  private sourceLimits: {
    limit: number;
    semaphores: Map<string, Semaphore>;
  } | null = null;

  constructor() {
    this.initializeScrapers();
  }

  /**
   * Initialise tous les scrapers disponibles
   */
  private initializeScrapers(): void {
    // Asura - Spécialisé pour manhwa/manhua (coréen/chinois)
    this.registerScraper('asura', asuraComicScraper, {
      name: 'Asura',
      baseUrl: 'https://asurascans.com',
      type: 'manhwa',
      enabled: true,
    });

    // MangaDex - API officielle, catalogue multi-types (manga, manhwa, manhua)
    //
    // ⚠️ `type: 'multiple'` et non `'manga'` : `orderScrapersForType` ÉCARTE les
    // sources dont le type ne correspond pas, elle ne les relègue pas. Tant que
    // MangaDex était déclaré `'manga'`, il n'était jamais interrogé pour une série
    // manhwa/manhua, alors que son catalogue en contient. Contrepartie : il est
    // désormais tenté sur CHAQUE série, et son appariement exige un `malId`
    // (cf. `matchManga`) — sans lui la série repart sans chapitre.
    this.registerScraper('mangadex', mangadexScraper, {
      name: 'MangaDex',
      baseUrl: 'https://mangadex.org',
      type: 'multiple',
      enabled: true,
    });

    // MangaPark - Support multiple types (manga, manhwa, manhua)
    this.registerScraper('mangapark', mangaParkScraper, {
      name: 'MangaPark',
      baseUrl: 'https://mangapark.io',
      type: 'multiple',
      enabled: true,
    });

    // Mangapill - Support multiple types via Consumet API
    this.registerScraper('mangapill', mangaPillScraper, {
      name: 'Mangapill',
      baseUrl: 'https://mangapill.com',
      type: 'multiple',
      enabled: true,
    });

    // Weeb Central - Support multiple types
    this.registerScraper('weebcentral', weebCentralScraper, {
      name: 'Weeb Central',
      baseUrl: 'https://weebcentral.com',
      type: 'multiple',
      enabled: true,
    });

    // MangaKatana - Support multiple types
    this.registerScraper('mangakatana', mangaKatanaScraper, {
      name: 'MangaKatana',
      baseUrl: 'https://mangakatana.com',
      type: 'multiple',
      enabled: true,
    });

    // Rokari Comics — servi par le scraper générique `wpComicScraper`, une
    // instance par site. Chaque site garde ainsi sa propre ligne dans le bilan
    // de run, son propre coupe-circuit et son propre jeton de concurrence.
    //
    // ⚠️ La clé d'enregistrement doit être `name.toLowerCase()` sans espaces —
    // c'est ainsi que `getScraperConfig` retrouve la config à partir du nom que
    // le manager renvoie dans ses résultats.
    this.registerScraper('rokaricomics', rokariComicsScraper, {
      name: 'Rokari Comics',
      baseUrl: 'https://rokaricomics.com',
      type: 'manhwa',
      enabled: true,
    });

    // Ici vous pourrez ajouter d'autres scrapers :
    // this.registerScraper('mangakakalot', mangakakalotScraper, { type: 'manga', ... });
  }

  /**
   * Synchronise l'état des scrapers avec la base de données
   * Charge l'état enabled depuis la DB pour chaque provider
   */
  async syncWithDatabase(): Promise<void> {
    try {
      const { data: providers, error } = await supabase
        .from('providers')
        .select('name, enabled');

      if (error) {
        console.error('Error loading provider states from DB:', error);
        return;
      }

      if (!providers) return;

      // Mettre à jour l'état de chaque scraper selon la DB
      for (const provider of providers) {
        const key = provider.name.toLowerCase().replace(/\s+/g, '');
        const config = this.configs.get(key);
        
        if (config) {
          config.enabled = provider.enabled;
          console.log(`Synced ${provider.name}: ${provider.enabled ? 'enabled' : 'disabled'}`);
        }
      }

      this.initialized = true;
    } catch (error) {
      console.error('Error syncing scrapers with database:', error);
    }
  }

  /**
   * S'assure que le manager est synchronisé avec la DB avant de continuer.
   *
   * ⚠️ On mémoïse la PROMESSE, pas un booléen. `initialized` n'est posé qu'à la FIN
   * de `syncWithDatabase` : avec `CRON_CONCURRENCY` workers × 6 providers, les
   * premiers appels arrivaient tous avant la réponse et lançaient chacun leur propre
   * `SELECT providers`. Même motif que `ChapterService.providerCache`.
   *
   * ⚠️ Et surtout : `syncWithDatabase` avale ses erreurs et rend la main SANS poser
   * `initialized`. Une seule requête en échec suffisait donc à faire rejouer ce SELECT
   * à CHAQUE appel de `scrapeWithProvider` — un aller-retour Supabase par
   * (série × provider), des milliers par run, en silence. D'où le cooldown : en cas
   * d'échec on garde les configs par défaut et on retente au plus une fois par minute.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.syncPromise) return this.syncPromise;
    if (Date.now() < this.nextSyncRetryAt) return;

    this.syncPromise = this.syncWithDatabase().finally(() => {
      this.syncPromise = null;
      if (!this.initialized) {
        this.nextSyncRetryAt = Date.now() + ScraperManager.SYNC_RETRY_COOLDOWN_MS;
      }
    });

    return this.syncPromise;
  }

  /**
   * Active le coupe-circuit par source, pour la durée du process.
   *
   * 🔴 **Désactivé par défaut**, comme `scraperStats` et pour la même raison : ce
   * manager est un singleton importé aussi par l'application (process serveur de
   * longue durée), où une source coupée le resterait indéfiniment. Seul le cron
   * appelle cette méthode, et il vit le temps d'un run.
   *
   * Effet : après `threshold` erreurs CONSÉCUTIVES sur une même source (tout succès
   * remet le compteur à zéro), elle n'est plus interrogée jusqu'à la fin du run.
   * Sans ça, une source morte coûte un timeout plein (`SCRAPER_TIMEOUT_MS`) sur
   * chacune des centaines de séries restantes.
   *
   * ⚠️ Contrepartie assumée : une source qui rate-limite (429) peut être coupée pour
   * le run entier. C'est réversible au run suivant, et le bilan de run la nomme.
   */
  enableCircuitBreaker(threshold = 10): void {
    this.breaker = {
      threshold,
      consecutiveErrors: new Map(),
      tripped: new Set(),
    };
    console.log(`⚡ Circuit breaker enabled (${threshold} consecutive errors per source)`);
  }

  /** Sources coupées par le coupe-circuit depuis son activation. */
  trippedProviders(): string[] {
    return this.breaker ? [...this.breaker.tripped] : [];
  }

  private isTripped(providerName: string): boolean {
    return this.breaker?.tripped.has(providerName) ?? false;
  }

  /** Alimente le coupe-circuit. No-op tant que `enableCircuitBreaker` n'a pas été appelé. */
  private noteProviderOutcome(providerName: string, failed: boolean): void {
    const breaker = this.breaker;
    if (!breaker) return;

    if (!failed) {
      breaker.consecutiveErrors.set(providerName, 0);
      return;
    }

    const consecutive = (breaker.consecutiveErrors.get(providerName) ?? 0) + 1;
    breaker.consecutiveErrors.set(providerName, consecutive);

    if (consecutive >= breaker.threshold && !breaker.tripped.has(providerName)) {
      breaker.tripped.add(providerName);
      console.warn(
        `⛔ Circuit breaker OPEN for ${providerName}: ${consecutive} consecutive errors — skipped for the rest of this run`
      );
    }
  }

  /**
   * Borne la concurrence PAR SOURCE, pour la durée du process.
   *
   * 🔴 **Désactivé par défaut**, comme `scraperStats` et le coupe-circuit : ce manager
   * est un singleton importé aussi par l'application, où une file d'attente globale
   * ferait patienter des requêtes utilisateur derrière le scraping.
   *
   * ⚠️ Pourquoi ça change tout pour le cron : la charge par source était bornée par
   * accident, via `CRON_CONCURRENCY` (4 séries en vol ⇒ au plus 4 requêtes chez
   * chaque source). Impossible d'augmenter le débit sans augmenter la charge amont
   * d'autant. Avec la limite ici, les deux réglages se séparent : 8 séries de front
   * et toujours 4 requêtes max par source — soit exactement la charge d'avant.
   */
  enableSourceLimits(limit: number): void {
    this.sourceLimits = { limit, semaphores: new Map() };
    console.log(`🚦 Per-source concurrency limited to ${limit}`);
  }

  /** Sémaphore d'une source, créé à la demande. `null` si les limites sont désactivées. */
  private semaphoreFor(providerName: string): Semaphore | null {
    const config = this.sourceLimits;
    if (!config) return null;

    let semaphore = config.semaphores.get(providerName);
    if (!semaphore) {
      semaphore = new Semaphore(config.limit);
      config.semaphores.set(providerName, semaphore);
    }
    return semaphore;
  }

  /**
   * Enregistre un nouveau scraper
   */
  private registerScraper(
    key: string, 
    scraper: MangaScraper, 
    config: ScraperConfig
  ): void {
    this.scrapers.set(key, scraper);
    this.configs.set(key, config);
    console.log(`Registered scraper: ${config.name}`);
  }

  /**
   * Obtient un scraper spécifique
   */
  getScraper(providerName: string): MangaScraper | null {
    const key = providerName.toLowerCase().replace(/\s+/g, '');
    return this.scrapers.get(key) || null;
  }

  /**
   * Obtient la configuration d'un scraper
   */
  getScraperConfig(providerName: string): ScraperConfig | null {
    const key = providerName.toLowerCase().replace(/\s+/g, '');
    return this.configs.get(key) || null;
  }

  /**
   * Liste tous les scrapers disponibles
   */
  getAvailableScrapers(): ScraperConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Liste tous les scrapers activés
   */
  async getEnabledScrapers(): Promise<ScraperConfig[]> {
    await this.ensureInitialized();
    return Array.from(this.configs.values()).filter(config => config.enabled);
  }

  /**
   * Scrape chapters en utilisant un provider spécifique
   */
  async scrapeWithProvider(
    providerName: string, 
    mangaTitle: string,
    malId?: number,
    titleSynonyms?: string[],
    titleEnglish?: string
  ): Promise<ScrapedChapter[]> {
    await this.ensureInitialized();
    
    const scraper = this.getScraper(providerName);
    
    if (!scraper) {
      throw new Error(`Scraper not found for provider: ${providerName}`);
    }

    const config = this.getScraperConfig(providerName);
    if (!config?.enabled) {
      throw new Error(`Scraper disabled for provider: ${providerName}`);
    }

    console.log(`Using ${config.name} scraper for: ${mangaTitle}${malId ? ` (MAL ID: ${malId})` : ''}`);
    return await scraper.scrapeChapters(mangaTitle, malId, titleSynonyms, titleEnglish);
  }

  /**
   * Scrape chapters en essayant tous les providers activés
   * Retourne le premier résultat non-vide
   */
  async scrapeWithAnyProvider(
    mangaTitle: string, 
    malId?: number,
    titleSynonyms?: string[]
  ): Promise<{
    chapters: ScrapedChapter[];
    provider: string;
  }> {
    const enabledScrapers = await this.getEnabledScrapers();
    
    for (const config of enabledScrapers) {
      try {
        console.log(`Trying ${config.name} for: ${mangaTitle}`);
        const chapters = await this.scrapeWithProvider(config.name, mangaTitle, malId, titleSynonyms);
        
        if (chapters.length > 0) {
          console.log(`✓ Found ${chapters.length} chapters using ${config.name}`);
          return {
            chapters,
            provider: config.name,
          };
        }
      } catch (error) {
        console.warn(`✗ ${config.name} failed:`, error);
        continue;
      }
    }

    return {
      chapters: [],
      provider: '',
    };
  }

  /**
   * Normalise le type de manga (traite manhua comme manhwa)
   */
  private normalizeMangaType(mangaType?: string): string {
    if (!mangaType) return 'manga';
    
    const normalized = mangaType.toLowerCase().trim();
    
    // Traiter manhua comme manhwa
    if (normalized === 'manhua') {
      return 'manhwa';
    }
    
    return normalized;
  }

  /**
   * Ordonne les scrapers compatibles avec un type : les « multiple » d'abord, puis
   * ceux dont le type correspond exactement. Les sources incompatibles sont
   * ÉCARTÉES, pas reléguées en fin de liste.
   *
   * ⚠️ Cette logique était dupliquée à l'identique dans `scrapeByMangaType` et
   * `scrapeWithAllProviders`, avec dans les deux cas un tableau `otherScrapers`
   * consciencieusement rempli… puis jamais lu.
   */
  private orderScrapersForType(
    enabledScrapers: ScraperConfig[],
    normalizedType: string
  ): ScraperConfig[] {
    const ordered: ScraperConfig[] = [];

    for (const config of enabledScrapers) {
      if (config.type === 'multiple') {
        // Les scrapers "multiple" sont toujours prioritaires
        ordered.unshift(config);
      } else if (config.type === normalizedType) {
        // Scrapers qui correspondent au type
        ordered.push(config);
      }
      // Les autres sont incompatibles avec ce type : on ne les tente pas.
    }

    return ordered;
  }

  /**
   * Scrape chapters en priorisant les scrapers par type de manga
   * @param mangaTitle - Titre du manga
   * @param mangaType - Type du manga (Manga, Manhwa, Manhua, etc.)
   * @param malId - Optional MyAnimeList ID for precise matching
   * @param titleSynonyms - Optional array of alternative titles to try
   */
  async scrapeByMangaType(
    mangaTitle: string, 
    mangaType?: string,
    malId?: number,
    titleSynonyms?: string[]
  ): Promise<{
    chapters: ScrapedChapter[];
    provider: string;
  }> {
    const enabledScrapers = await this.getEnabledScrapers();

    if (!mangaType || enabledScrapers.length === 0) {
      // Si pas de type spécifié, utiliser la méthode normale
      return this.scrapeWithAnyProvider(mangaTitle, malId, titleSynonyms);
    }

    // Normaliser le type (manhua -> manhwa)
    const normalizedType = this.normalizeMangaType(mangaType);
    const orderedScrapers = this.orderScrapersForType(enabledScrapers, normalizedType);

    console.log(
      `Scraping for ${mangaType} (normalized: ${normalizedType}): ${mangaTitle}`
    );

    if (orderedScrapers.length === 0) {
      console.log(`⚠️ No compatible scrapers found for type: ${normalizedType}`);
      return {
        chapters: [],
        provider: '',
      };
    }

    console.log(
      `Scraper order: ${orderedScrapers.map(s => `${s.name} (${s.type})`).join(', ')}`
    );

    // Essayer chaque scraper dans l'ordre de priorité
    for (const config of orderedScrapers) {
      try {
        console.log(`Trying ${config.name} (${config.type}) for: ${mangaTitle}`);
        const chapters = await this.scrapeWithProvider(config.name, mangaTitle, malId, titleSynonyms);

        if (chapters.length > 0) {
          console.log(`✓ Found ${chapters.length} chapters using ${config.name}`);
          return {
            chapters,
            provider: config.name,
          };
        }
      } catch (error) {
        console.warn(`✗ ${config.name} failed:`, error);
        continue;
      }
    }

    return {
      chapters: [],
      provider: '',
    };
  }

  /**
   * Scrape chapters avec TOUS les providers compatibles (multiple providers par série)
   * @param mangaTitle - Titre du manga
   * @param mangaType - Type du manga (Manga, Manhwa, Manhua, etc.)
   * @param malId - Optional MyAnimeList ID for precise matching
   * @param titleSynonyms - Optional array of alternative titles to try
   * @param titleEnglish - Optional English title (for providers that prefer it)
   *
   * ⚠️ Le retour distingue trois choses que l'ancienne version confondait : ce qui a
   * été trouvé (`results`), ce qui a ÉCHOUÉ (`errors`), et ce qui n'a même pas été
   * tenté (`skipped`, coupe-circuit). Sans cette distinction, l'appelant ne peut pas
   * séparer « série absente de toutes les sources » de « tout est cassé » — et
   * avançait `last_chapters_update` dans les deux cas, masquant la panne 2 h durant.
   */
  async scrapeWithAllProviders(
    mangaTitle: string, 
    mangaType?: string,
    malId?: number,
    titleSynonyms?: string[],
    titleEnglish?: string
  ): Promise<AllProvidersOutcome> {
    const enabledScrapers = await this.getEnabledScrapers();

    if (enabledScrapers.length === 0) {
      return { results: [], errors: [], attempted: 0, skipped: [], busyMs: 0, waitedMs: 0 };
    }

    // Normaliser le type (manhua -> manhwa)
    const normalizedType = this.normalizeMangaType(mangaType);
    const orderedScrapers = this.orderScrapersForType(enabledScrapers, normalizedType);

    console.log(
      `Scraping with ALL providers for ${mangaType || 'unknown'} (normalized: ${normalizedType}): ${mangaTitle}`
    );

    if (orderedScrapers.length === 0) {
      console.log(`⚠️ No compatible scrapers found for type: ${normalizedType}`);
      return { results: [], errors: [], attempted: 0, skipped: [], busyMs: 0, waitedMs: 0 };
    }

    // Coupe-circuit : une source déclarée morte pour ce run n'est plus interrogée —
    // elle coûterait un timeout plein sur CHACUNE des séries restantes.
    const skipped = orderedScrapers
      .filter((config) => this.isTripped(config.name))
      .map((config) => config.name);
    const runnableScrapers = orderedScrapers.filter(
      (config) => !this.isTripped(config.name)
    );

    if (runnableScrapers.length === 0) {
      // ⚠️ `skipped` non vide ⇒ l'appelant DOIT traiter ça comme un échec, jamais
      // comme une série absente partout : sinon le coupe-circuit ferait avancer les
      // timestamps de tout le reste du catalogue sans avoir rien scrapé.
      console.warn(`⛔ All compatible providers are tripped — skipping ${mangaTitle}`);
      return { results: [], errors: [], attempted: 0, skipped, busyMs: 0, waitedMs: 0 };
    }

    console.log(
      `Scraper order: ${runnableScrapers.map(s => `${s.name} (${s.type})`).join(', ')}`
    );

    // Temps par provider, renseigné succès COMME échec : sans la branche d'échec, un
    // provider qui plante en timeout ne compterait pour rien dans le coût de la série.
    const timings: Array<{ busyMs: number; waitedMs: number }> = new Array(
      runnableScrapers.length
    );

    // Lancer tous les scrapers en parallèle (chaque provider ne reçoit qu'1 requête par manga)
    const scraperPromises = runnableScrapers.map(async (config, index) => {
      const titleToUse = ((config.name === 'MangaPark' || config.name === 'Weeb Central') && titleEnglish) ? titleEnglish : mangaTitle;

      // Jeton de la source. Le `run` mesure l'attente à part : la faire compter comme
      // du scraping gonflerait le taux d'occupation du bilan jusqu'à le rendre inutile.
      const semaphore = this.semaphoreFor(config.name);

      const scrape = async (waitedMs: number) => {
        console.log(`Trying ${config.name} (${config.type}) for: ${titleToUse}${titleToUse !== mangaTitle ? ` (original: ${mangaTitle})` : ''}`);

        // Chronométrage par provider — no-op hors cron (cf. `scraperStats`).
        // C'est LE point de mesure : la durée d'une série = celle du provider le
        // plus lent, puisqu'ils tournent tous en parallèle ci-dessous.
        const startedAt = Date.now();
        try {
          const chapters = await this.scrapeWithProvider(config.name, titleToUse, malId, titleSynonyms, titleEnglish);
          timings[index] = { busyMs: Date.now() - startedAt, waitedMs };
          scraperStats.record({
            provider: config.name,
            ms: Date.now() - startedAt,
            // Depuis le contrat d'erreur (cf. `scrapers/types.ts`), « 0 chapitre » veut
            // enfin dire « série absente chez ce provider » : une panne lève désormais
            // une exception et tombe dans le `catch` ci-dessous (outcome `error`).
            // La colonne « empty » reste à surveiller — un sélecteur qui ne matche plus
            // produit un vide parfaitement légitime en apparence.
            outcome: chapters.length > 0 ? 'chapters' : 'empty',
            chapters: chapters.length,
          });
          return { chapters, provider: config.name };
        } catch (error) {
          timings[index] = { busyMs: Date.now() - startedAt, waitedMs };
          scraperStats.record({
            provider: config.name,
            ms: Date.now() - startedAt,
            outcome: 'error',
            chapters: 0,
          });
          throw error;
        }
      };

      // Sans limite par source : aucune attente possible, donc 0.
      if (!semaphore) return scrape(0);
      return semaphore.run((waitedMs) => scrape(waitedMs));
    });

    const settled = await Promise.allSettled(scraperPromises);

    const results: Array<{ chapters: ScrapedChapter[]; provider: string }> = [];
    const errors: ProviderError[] = [];

    // `Promise.allSettled` conserve l'ordre de `runnableScrapers` : on peut donc
    // nommer le provider en échec (le log disait seulement « a scraper failed »).
    settled.forEach((outcome, index) => {
      const configName = runnableScrapers[index]?.name ?? 'unknown';
      if (outcome.status === 'fulfilled') {
        this.noteProviderOutcome(configName, false);
        const { chapters, provider } = outcome.value;
        if (chapters.length > 0) {
          console.log(`✓ Found ${chapters.length} chapters using ${provider}`);
          results.push({ chapters, provider });
        } else {
          console.log(`○ No chapters found with ${provider}`);
        }
      } else {
        this.noteProviderOutcome(configName, true);
        errors.push({
          provider: configName,
          message:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
        });
        console.warn(`✗ ${configName} failed:`, outcome.reason);
      }
    });

    // Une série coûte le temps de son provider le plus lent : ils sont parallèles,
    // sommer serait compter plusieurs fois la même seconde de mur.
    const busyMs = timings.reduce((max, t) => Math.max(max, t?.busyMs ?? 0), 0);
    const waitedMs = timings.reduce((max, t) => Math.max(max, t?.waitedMs ?? 0), 0);

    console.log(
      `Total: Found chapters from ${results.length} provider(s), ${errors.length} error(s)`
    );

    return {
      results,
      errors,
      attempted: runnableScrapers.length,
      skipped,
      busyMs,
      waitedMs,
    };
  }

  /**
   * Active ou désactive un scraper (état en mémoire uniquement)
   * Pour persister en DB, utilisez l'API admin route
   */
  toggleScraper(providerName: string, enabled: boolean): boolean {
    const key = providerName.toLowerCase().replace(/\s+/g, '');
    const config = this.configs.get(key);
    
    if (!config) {
      console.error(`Provider not found: ${providerName}`);
      return false;
    }

    config.enabled = enabled;
    console.log(`${config.name} scraper ${enabled ? 'enabled' : 'disabled'} (in-memory only)`);
    return true;
  }
}

// Instance singleton
export const scraperManager = new ScraperManager();
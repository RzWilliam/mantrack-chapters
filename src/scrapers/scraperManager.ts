import { ScrapedChapter } from "../types";
import { MangaScraper, ScraperConfig } from './types';
import { asuraComicScraper } from './asuraComicScraper';
import { mangadexScraper } from './mangadexScraper';
import { mangaParkScraper } from './mangaParkScraper';
import { mangaPillScraper } from './mangaPillScraper';
import { weebCentralScraper } from './weebCentralScraper';
import { mangaKatanaScraper } from './mangaKatanaScraper';
import { supabase } from "../lib/supabase";

/**
 * Manager pour gérer tous les scrapers de manga
 */
export class ScraperManager {
  private scrapers: Map<string, MangaScraper> = new Map();
  private configs: Map<string, ScraperConfig> = new Map();
  private initialized: boolean = false;

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

    // MangaDex - API officielle pour manga (japonais)
    this.registerScraper('mangadex', mangadexScraper, {
      name: 'MangaDex',
      baseUrl: 'https://mangadex.org',
      type: 'manga',
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
   * S'assure que le manager est synchronisé avec la DB avant de continuer
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.syncWithDatabase();
    }
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
    
    // Priorité : scrapers qui correspondent au type exact
    const prioritizedScrapers: ScraperConfig[] = [];
    const otherScrapers: ScraperConfig[] = [];
    
    for (const config of enabledScrapers) {
      if (config.type === 'multiple') {
        // Les scrapers "multiple" sont toujours prioritaires
        prioritizedScrapers.unshift(config);
      } else if (config.type === normalizedType) {
        // Scrapers qui correspondent au type
        prioritizedScrapers.push(config);
      } else {
        // Autres scrapers
        otherScrapers.push(config);
      }
    }

    // Combiner : prioritaires d'abord UNIQUEMENT (pas les "other scrapers" incompatibles)
    const orderedScrapers = [...prioritizedScrapers];

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
   */
  async scrapeWithAllProviders(
    mangaTitle: string, 
    mangaType?: string,
    malId?: number,
    titleSynonyms?: string[],
    titleEnglish?: string
  ): Promise<{
    results: Array<{
      chapters: ScrapedChapter[];
      provider: string;
    }>;
  }> {
    const enabledScrapers = await this.getEnabledScrapers();
    
    if (enabledScrapers.length === 0) {
      return { results: [] };
    }

    // Normaliser le type (manhua -> manhwa)
    const normalizedType = this.normalizeMangaType(mangaType);
    
    // Priorité : scrapers qui correspondent au type exact
    const prioritizedScrapers: ScraperConfig[] = [];
    const otherScrapers: ScraperConfig[] = [];
    
    for (const config of enabledScrapers) {
      if (config.type === 'multiple') {
        // Les scrapers "multiple" sont toujours prioritaires
        prioritizedScrapers.unshift(config);
      } else if (config.type === normalizedType) {
        // Scrapers qui correspondent au type
        prioritizedScrapers.push(config);
      } else {
        // Autres scrapers
        otherScrapers.push(config);
      }
    }

    // Combiner : prioritaires UNIQUEMENT (pas les "other scrapers" incompatibles)
    const orderedScrapers = [...prioritizedScrapers];

    console.log(
      `Scraping with ALL providers for ${mangaType || 'unknown'} (normalized: ${normalizedType}): ${mangaTitle}`
    );
    
    if (orderedScrapers.length === 0) {
      console.log(`⚠️ No compatible scrapers found for type: ${normalizedType}`);
      return { results: [] };
    }
    
    console.log(
      `Scraper order: ${orderedScrapers.map(s => `${s.name} (${s.type})`).join(', ')}`
    );

    // Lancer tous les scrapers en parallèle (chaque provider ne reçoit qu'1 requête par manga)
    const scraperPromises = orderedScrapers.map(async (config) => {
      const titleToUse = ((config.name === 'MangaPark' || config.name === 'Weeb Central') && titleEnglish) ? titleEnglish : mangaTitle;
      console.log(`Trying ${config.name} (${config.type}) for: ${titleToUse}${titleToUse !== mangaTitle ? ` (original: ${mangaTitle})` : ''}`);
      const chapters = await this.scrapeWithProvider(config.name, titleToUse, malId, titleSynonyms, titleEnglish);
      return { chapters, provider: config.name };
    });

    const settled = await Promise.allSettled(scraperPromises);

    const results: Array<{ chapters: ScrapedChapter[]; provider: string }> = [];

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        const { chapters, provider } = outcome.value;
        if (chapters.length > 0) {
          console.log(`✓ Found ${chapters.length} chapters using ${provider}`);
          results.push({ chapters, provider });
        } else {
          console.log(`○ No chapters found with ${provider}`);
        }
      } else {
        console.warn(`✗ A scraper failed:`, outcome.reason);
      }
    }

    console.log(`Total: Found chapters from ${results.length} provider(s)`);

    return { results };
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
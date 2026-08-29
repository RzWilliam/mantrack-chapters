import { ScrapedChapter } from "../types";

/**
 * Interface générale pour tous les scrapers de manga
 */
export interface MangaScraper {
  /**
   * Scrape chapters for a given manga title
   * @param mangaTitle - The title of the manga to search for
   * @param malId - Optional MyAnimeList ID for precise matching
   * @param titleSynonyms - Optional array of alternative titles to try
   * @param titleEnglish - Optional English title (used by some providers like Weeb Central)
   * @returns Promise<ScrapedChapter[]> - Array of scraped chapters
   */
  scrapeChapters(mangaTitle: string, malId?: number, titleSynonyms?: string[], titleEnglish?: string): Promise<ScrapedChapter[]>;
}

/**
 * Résultat de recherche générique
 */
export interface SearchResult {
  title: string;
  url: string;
  image?: string;
}

/**
 * Configuration pour un scraper
 * Note: 'manhua' sera automatiquement normalisé en 'manhwa' par le scraperManager
 */
export interface ScraperConfig {
  name: string;
  baseUrl: string;
  type: 'manga' | 'manhwa' | 'multiple';
  enabled: boolean;
}

/**
 * Statistiques de scraping
 */
export interface ScrapingStats {
  searchResults: number;
  chaptersFound: number;
  bestMatchScore: number;
  executionTime: number;
}
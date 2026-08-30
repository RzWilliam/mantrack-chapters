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
   *
   * 🔴 **Contrat d'erreur (2026-08-31) — un tableau vide signifie « rien trouvé »,
   * JAMAIS « ça a échoué ».**
   *
   * - Série absente chez ce provider, recherche sans résultat, aucun titre
   *   suffisamment proche → `return []`. C'est un cas normal.
   * - Réseau, statut HTTP non-OK, timeout, exception de parsing (le HTML amont a
   *   changé) → **laisser remonter l'exception**. Ne jamais la convertir en `[]`.
   *
   * ⚠️ Pourquoi c'est une règle et pas une préférence : tous les scrapers faisaient
   * `catch → return []`, rendant une panne **indiscernable** d'un vide légitime.
   * Weeb Central est resté muet en production sans que rien ne le signale
   * (2026-08-29), et il a fallu une session entière pour le diagnostiquer. Les
   * appelants savent tous gérer un rejet : `scrapeWithAllProviders` isole le
   * provider fautif via `Promise.allSettled`, les stratégies séquentielles font
   * `catch + continue`, et la route de test admin affiche le message d'erreur.
   * C'est aussi ce qui rend fiable la colonne `Empty` du bilan de run
   * (cf. `src/lib/scraperStats.ts`).
   *
   * ⚠️ **Limite connue, non couverte** : un sélecteur CSS qui ne matche RIEN ne
   * lève pas d'exception — il renvoie un tableau vide, donc « rien trouvé ». Une
   * page dont le HTML a changé reste donc indiscernable d'une page de résultats
   * légitimement vide (`mangaKatanaScraper` `#book_list .item` et
   * `.chapters .chapter`, et leurs équivalents ailleurs). Lever une erreur à cet
   * endroit ferait passer toute série réellement absente pour une panne. La levée
   * n'est justifiée que si le CONTENEUR lui-même a disparu — à traiter scraper par
   * scraper, ce n'est pas fait.
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
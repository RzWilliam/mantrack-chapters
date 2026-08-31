/**
 * Point d'entrée du package `@mantrack/chapters`.
 *
 * Deux consommateurs, un seul code source :
 *  - le cron chapitres de ce dépôt (`src/cron/update-chapters.ts`, via tsx) ;
 *  - l'application ManTrack (dépôt privé), qui compile ce package avec
 *    `transpilePackages` — donc exactement la même chaîne SWC qu'avant l'extraction.
 *
 * Ajouter/retirer un provider : voir README.md §« Ajouter un provider ».
 */

// Types du domaine « chapitres » (réexportés côté app dans types/manga.ts)
export * from "./types";

// Service de lecture/écriture des chapitres en base
export {
  ChapterService,
  chapterService,
  type LatestChapterProvider,
  type LatestChapterCard,
} from "./chapterService";

// Orchestrateur de scrapers + interface à implémenter pour un nouveau provider
export {
  ScraperManager,
  scraperManager,
  type ProviderError,
  type AllProvidersOutcome,
} from "./scrapers/scraperManager";
export type {
  MangaScraper,
  SearchResult,
  ScraperConfig,
  ScrapingStats,
} from "./scrapers/types";

// Scrapers individuels (utile pour les tests manuels / la route admin de test)
export {
  asuraComicScraper,
  mangadexScraper,
  mangaParkScraper,
  mangaPillScraper,
  weebCentralScraper,
  mangaKatanaScraper,
  // Scraper générique WordPress + ses instances (une par site configuré)
  WpComicScraper,
  rokariComicsScraper,
} from "./scrapers";
export type { WpComicSite } from "./scrapers";

// Clients Supabase du package (anon = données publiques, admin = service-role)
export { supabase } from "./lib/supabase";
export { supabaseAdmin } from "./lib/supabaseAdmin";

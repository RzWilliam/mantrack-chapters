/**
 * Types du domaine « chapitres » — la couche scrapers.
 *
 * ⚠️ Source de vérité unique : côté application, `types/manga.ts` réexporte ce
 * fichier plutôt que d'en garder une copie. Ne pas dupliquer ces interfaces.
 */

// Types pour les providers de chapitres
export interface Provider {
  id: string;
  name: string;
  type: 'manga' | 'manhwa' | 'manhua' | 'multiple';
  base_url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// Types pour les chapitres
export interface Chapter {
  id: string;
  chapter_number: number;
  link: string;
  release_date: string | null;
  provider_id: string;
  manga_id: number;
  created_at: string;
  updated_at: string;
}

// Type pour les chapitres avec informations du provider
export interface ChapterWithProvider extends Chapter {
  provider: Provider;
}

// Type pour la réponse API des chapitres
export interface ChaptersResponse {
  chapters: ChapterWithProvider[];
  total: number;
  page: number;
  limit: number;
}

// Type pour les données scrapées d'Asura
export interface ScrapedChapter {
  chapter_number: number;
  link: string;
  release_date: string | null;
}

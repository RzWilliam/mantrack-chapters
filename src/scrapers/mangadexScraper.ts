import { ScrapedChapter } from "../types";
import { scraperSignal } from "../lib/http";

export interface MangaDexSearchResult {
  id: string;
  title: string;
  altTitles: string[];
  malId?: string;
}

interface MangaDexApiManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    links?: {
      mal?: string;
      [key: string]: string | undefined;
    };
  };
}

interface MangaDexApiChapter {
  id: string;
  attributes: {
    chapter: string;
    publishAt: string | null;
    /**
     * Renseigné sur les chapitres « Official Publisher » : la page MangaDex ne
     * contient aucune image et redirige vers l'éditeur (K Manga, MANGA Plus,
     * Comikey…). Cf. `getChapters` pour pourquoi on ne les remonte jamais.
     */
    externalUrl?: string | null;
    pages?: number;
  };
}

export class MangaDexScraper {
  private baseUrl = "https://api.mangadex.org";
  private readonly ENGLISH_LANGUAGE = "en";

  /**
   * Main method to scrape chapters for a manga using mal_id for precise matching
   * @param mangaTitle - Titre du manga (utilisé pour la recherche partielle)
   * @param malId - MAL ID du manga (REQUIS pour trouver le bon manga)
   * @param titleSynonyms - Optional array of alternative titles (not used by MangaDex)
   */
  async scrapeChapters(
    mangaTitle: string,
    malId?: number,
    titleSynonyms?: string[]
  ): Promise<ScrapedChapter[]> {
    try {
      console.log(
        `Scraping MangaDex for: ${mangaTitle}${malId ? ` (MAL ID: ${malId})` : " (WARNING: No MAL ID provided)"}`
      );

      // Step 1: Search for the manga with partial title (max 3 mots)
      const searchResults = await this.searchManga(mangaTitle);
      if (searchResults.length === 0) {
        console.log(`No manga found for "${mangaTitle}" on MangaDex`);
        return [];
      }

      console.log(`Found ${searchResults.length} search results`);

      // Step 2: Find match using MAL ID (required)
      const bestMatch = this.findBestMatch(mangaTitle, searchResults, malId);
      if (!bestMatch) {
        if (malId) {
          console.log(`✗ No manga with MAL ID ${malId} found in search results`);
        } else {
          console.log(`✗ MAL ID is required to match manga on MangaDex`);
        }
        return [];
      }

      console.log(
        `Best match: ${bestMatch.title} (${bestMatch.id})${
          bestMatch.malId ? ` - MAL ID: ${bestMatch.malId}` : ""
        }`
      );

      // Step 3: Get chapters from the manga
      return await this.getChapters(bestMatch.id);
    } catch (error) {
      console.error("Error scraping MangaDex:", error);
      throw error;
    }
  }

  /**
   * Search for manga on MangaDex API using partial title
   */
  private async searchManga(title: string): Promise<MangaDexSearchResult[]> {
    try {
      // Extraire les mots significatifs du titre (enlever les articles, etc.)
      const searchQuery = this.extractKeywords(title);
      const searchUrl = `${this.baseUrl}/manga?title=${encodeURIComponent(
        searchQuery
      )}&limit=20&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&includes[]=cover_art`;

      console.log(`Searching MangaDex API with keywords: "${searchQuery}"`);

      const response = await fetch(searchUrl, {
        signal: scraperSignal(),
        headers: {
          "User-Agent": "ManTrack/1.0",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Search failed with status: ${response.status}`);
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        return [];
      }

      return data.data.map((manga: MangaDexApiManga) => {
        const titleObj = manga.attributes.title;
        const altTitlesArr = manga.attributes.altTitles || [];
        const links = manga.attributes.links;

        // Extract main title (prefer English, fallback to any available)
        const mainTitle =
          titleObj.en ||
          titleObj["ja-ro"] ||
          titleObj.ja ||
          Object.values(titleObj)[0] ||
          "Unknown";

        // Extract alternative titles
        const altTitles = altTitlesArr.flatMap((altTitle: Record<string, string>) =>
          Object.values(altTitle)
        );

        // Extract MAL ID if available
        const malId = links?.mal;

        return {
          id: manga.id,
          title: mainTitle as string,
          altTitles: altTitles as string[],
          malId: malId,
        };
      });
    } catch (error) {
      console.error("Error searching MangaDex:", error);
      throw error;
    }
  }

  /**
   * Extract first 3 words from title for search
   */
  private extractKeywords(title: string): string {
    const words = title
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .slice(0, 3)
      .join(" ");
    
    console.log(`Extracted first 3 words from "${title}": "${words}"`);
    return words;
  }

  /**
   * Find the matching manga from search results using MAL ID
   * Returns null if no MAL ID match is found
   */
  private findBestMatch(
    searchTitle: string,
    results: MangaDexSearchResult[],
    malId?: number
  ): MangaDexSearchResult | null {
    if (results.length === 0) return null;

    // Si un MAL ID est fourni, chercher UNIQUEMENT une correspondance exacte
    if (malId) {
      const malIdStr = malId.toString();
      const exactMatch = results.find((result) => result.malId === malIdStr);
      
      if (exactMatch) {
        console.log(`✓ Found exact match using MAL ID: ${malId}`);
        return exactMatch;
      } else {
        console.log(`✗ No manga found with MAL ID: ${malId} in search results`);
        return null;
      }
    }

    // Si pas de MAL ID fourni, retourner null
    console.log(`✗ No MAL ID provided, cannot match manga`);
    return null;
  }

  /**
   * Get chapters for a manga from MangaDex API
   *
   * 🔴 Les chapitres « Official Publisher » sont exclus, à deux niveaux.
   *
   * MangaDex référence de plus en plus de chapitres qui ne sont qu'un lien vers
   * l'éditeur (K Manga, MANGA Plus, Comikey…). Sur ces plateformes, seuls les
   * derniers chapitres sont lisibles gratuitement, et temporairement : dès qu'un
   * nouveau chapitre sort, le plus ancien de la fenêtre gratuite passe payant.
   * Un lien stocké vers un tel chapitre devient donc obsolète en quelques
   * semaines. Blue Lock (2026-09-04) : 26 chapitres K Manga en anglais pour une
   * seule scantrad.
   *
   * Dans l'API, ces chapitres portent `attributes.externalUrl` (et `pages: 0`).
   *
   *  1. `includeExternalUrl=0` dans le feed. ⚠️ Ce n'est pas un booléen
   *     « inclure aussi » mais un FILTRE strict, vérifié en direct : `0` → seuls
   *     les chapitres sans `externalUrl` ; `1` → seuls ceux qui en ont un ;
   *     paramètre absent → les deux. Ne pas « simplifier » en le retirant.
   *  2. Un contrôle sur `externalUrl` dans la réponse, par sécurité : si MangaDex
   *     renommait ou ignorait le paramètre, les liens payants reviendraient sans
   *     qu'aucun log ne le signale. Le compteur `skippedExternal` rend ce cas
   *     visible. Le contrôle passe AVANT la déduplication, sinon un chapitre
   *     externe masquerait la scantrad du même numéro.
   */
  private async getChapters(mangaId: string): Promise<ScrapedChapter[]> {
    try {
      const chapters: ScrapedChapter[] = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;
      let skippedExternal = 0;

      // Fetch all chapters with pagination
      while (hasMore) {
        const chaptersUrl = `${this.baseUrl}/manga/${mangaId}/feed?limit=${limit}&offset=${offset}&translatedLanguage[]=${this.ENGLISH_LANGUAGE}&order[chapter]=asc&includeFutureUpdates=0&includeExternalUrl=0`;

        console.log(`Fetching chapters: offset=${offset}`);

        const response = await fetch(chaptersUrl, {
          signal: scraperSignal(),
          headers: {
            "User-Agent": "ManTrack/1.0",
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          // ⚠️ `break` renvoyait une liste PARTIELLE présentée comme complète —
          // pire qu'un vide : des chapitres manquants sans aucun signal.
          throw new Error(`Failed to fetch chapters: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data || data.data.length === 0) {
          hasMore = false;
          break;
        }

        // Process chapters and remove duplicates
        const seenChapters = new Set<number>();

        for (const chapter of data.data as MangaDexApiChapter[]) {
          const chapterNumber = parseFloat(chapter.attributes.chapter);

          // Skip if not a valid chapter number
          if (isNaN(chapterNumber)) continue;

          // Official Publisher : lien externe, payant à court terme (cf. doc ci-dessus)
          if (chapter.attributes.externalUrl) {
            skippedExternal++;
            continue;
          }

          // Skip duplicates
          if (seenChapters.has(chapterNumber)) continue;

          seenChapters.add(chapterNumber);

          const chapterUrl = `https://mangadex.org/chapter/${chapter.id}`;
          const releaseDate = chapter.attributes.publishAt || null;

          chapters.push({
            chapter_number: chapterNumber,
            link: chapterUrl,
            release_date: releaseDate,
          });
        }

        // Check if there are more chapters
        offset += limit;
        hasMore = data.data.length === limit;
      }

      if (skippedExternal > 0) {
        // Ne devrait jamais s'afficher : le feed est déjà filtré côté serveur.
        console.warn(
          `⚠️ MangaDex: includeExternalUrl=0 was not honoured — skipped ${skippedExternal} official-publisher chapter(s) client-side`
        );
      }

      // Remove duplicates based on chapter_number (in case we missed any)
      const uniqueChapters = this.removeDuplicateChapters(chapters);

      console.log(
        `Found ${uniqueChapters.length} unique English chapters on MangaDex`
      );
      return uniqueChapters;
    } catch (error) {
      console.error("Error fetching chapters from MangaDex:", error);
      throw error;
    }
  }

  /**
   * Remove duplicate chapters, keeping the first occurrence
   */
  private removeDuplicateChapters(
    chapters: ScrapedChapter[]
  ): ScrapedChapter[] {
    const seen = new Map<number, ScrapedChapter>();

    for (const chapter of chapters) {
      if (!seen.has(chapter.chapter_number)) {
        seen.set(chapter.chapter_number, chapter);
      }
    }

    return Array.from(seen.values()).sort(
      (a, b) => a.chapter_number - b.chapter_number
    );
  }
}

// Export singleton instance
export const mangadexScraper: MangaDexScraper = new MangaDexScraper();

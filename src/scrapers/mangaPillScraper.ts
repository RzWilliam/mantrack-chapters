import { ScrapedChapter } from "../types";
import { scraperSignal } from "../lib/http";
import { MangaScraper } from "./types";

/**
 * Interface pour les résultats de recherche Mangapill via Consumet
 */
interface MangapillSearchResult {
  id: string;
  title: string;
  image?: string;
  headerForImage?: Record<string, string>;
}

/**
 * Interface pour les informations détaillées d'un manga
 */
interface MangapillMangaInfo {
  id: string;
  title: string;
  altTitles?: string[];
  description?: string;
  genres?: string[];
  status?: string;
  image?: string;
  chapters?: MangapillChapter[];
}

/**
 * Interface pour un chapitre Mangapill
 */
interface MangapillChapter {
  id: string;
  title: string;
  releaseDate?: string;
}

/**
 * Scraper pour Mangapill utilisant l'API Vercel avec Consumet
 */
export class MangaPillScraper implements MangaScraper {
  private baseApiUrl = "https://mantrack-api.vercel.app/manga/mangapill";

  /**
   * Sépare les titres multiples concaténés (détecte les majuscules consécutives)
   * Exemple: "Aishiteru Game wo OwarasetaiI Want to End..." 
   * -> ["Aishiteru Game wo Owarasetai", "I Want to End..."]
   */
  private splitConcatenatedTitles(title: string): string[] {
    const titles: string[] = [];
    
    // Détecter les positions où 2 majuscules se suivent (pas en début de mot)
    const pattern = /([a-z])([A-Z])/g;
    const splitPositions: number[] = [];
    
    let match;
    while ((match = pattern.exec(title)) !== null) {
      splitPositions.push(match.index + 1);
    }
    
    if (splitPositions.length === 0) {
      return [title];
    }
    
    // Diviser le titre aux positions détectées
    let lastPos = 0;
    for (const pos of splitPositions) {
      const part = title.substring(lastPos, pos).trim();
      if (part) titles.push(part);
      lastPos = pos;
    }
    
    // Ajouter la dernière partie
    const lastPart = title.substring(lastPos).trim();
    if (lastPart) titles.push(lastPart);
    
    return titles.length > 0 ? titles : [title];
  }

  /**
   * Extrait le slug depuis l'ID
   * Exemple: "6580/aishiteru-game-wo-owarasetai" -> "aishiteru-game-wo-owarasetai"
   */
  private extractSlugFromId(id: string): string {
    const parts = id.split('/');
    return parts[parts.length - 1] || id;
  }

  /**
   * Convertit un slug en titre lisible
   * Exemple: "aishiteru-game-wo-owarasetai" -> "aishiteru game wo owarasetai"
   */
  private slugToTitle(slug: string): string {
    return slug.replace(/-/g, ' ');
  }

  /**
   * Normalise un titre pour la comparaison
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Calcule le score de similarité entre deux titres
   */
  private calculateSimilarity(title1: string, title2: string): number {
    const norm1 = this.normalizeTitle(title1);
    const norm2 = this.normalizeTitle(title2);

    if (norm1 === norm2) return 1.0;

    // Jaccard similarity avec les mots
    const words1 = new Set(norm1.split(" "));
    const words2 = new Set(norm2.split(" "));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * Trouve le meilleur match parmi les résultats de recherche
   */
  private findBestMatch(
    searchTitle: string,
    results: MangapillSearchResult[],
    titleSynonyms?: string[]
  ): MangapillSearchResult | null {
    if (results.length === 0) return null;

    const allTitlesToMatch = [searchTitle, ...(titleSynonyms || [])];
    
    // 🎯 SINGLE WORD TITLE: Require exact match
    // Check if the primary search title is a single word (after normalization)
    const normalizedSearchTitle = this.normalizeTitle(searchTitle);
    const searchWords = normalizedSearchTitle.split(" ").filter(w => w.length > 0);
    const isSingleWordTitle = searchWords.length === 1;
    
    if (isSingleWordTitle) {
      const singleWord = searchWords[0];
      console.log(`🎯 Single word title detected: "${singleWord}" - requiring perfect match (title must be ONLY that word)`);
      
      for (const result of results) {
        const separatedTitles = this.splitConcatenatedTitles(result.title);
        const slug = this.extractSlugFromId(result.id);
        const slugAsTitle = this.slugToTitle(slug);
        const allResultTitles = [...separatedTitles, slugAsTitle];
        
        for (const resultTitle of allResultTitles) {
          const normalizedResultTitle = this.normalizeTitle(resultTitle);
          const resultWords = normalizedResultTitle.split(" ").filter(w => w.length > 0);
          
          // The result must contain ONLY the single word, no other words
          if (resultWords.length === 1 && resultWords[0] === singleWord) {
            console.log(`✅ Found perfect match: "${result.title}"`);
            return result;
          }
        }
      }
      
      console.log(`❌ No perfect match found for single word title "${singleWord}" (titles with additional words were rejected)`);
      return null;
    }
    
    // For multi-word titles, use similarity scoring
    let bestMatch: MangapillSearchResult | null = null;
    let bestScore = 0;
    let matchDetails = "";

    for (const result of results) {
      // Séparer les titres concaténés dans le résultat
      const separatedTitles = this.splitConcatenatedTitles(result.title);
      
      // Extraire le slug de l'ID
      const slug = this.extractSlugFromId(result.id);
      const slugAsTitle = this.slugToTitle(slug);
      
      // Ajouter le slug comme titre alternatif
      const allResultTitles = [...separatedTitles, slugAsTitle];
      
      // Comparer avec tous les titres possibles
      for (const titleToMatch of allTitlesToMatch) {
        for (const resultTitle of allResultTitles) {
          const score = this.calculateSimilarity(titleToMatch, resultTitle);
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = result;
            matchDetails = `"${titleToMatch}" matched with "${resultTitle}" (from ${
              resultTitle === slugAsTitle ? 'slug' : 'title'
            })`;
          }
        }
      }
    }

    // Seuil de similarité minimum
    if (bestScore < 0.4) {
      console.log(`Best match score ${bestScore.toFixed(2)} is below threshold`);
      return null;
    }

    console.log(`Best match: "${bestMatch?.title}" (ID: ${bestMatch?.id})`);
    console.log(`  Score: ${bestScore.toFixed(2)} - ${matchDetails}`);
    return bestMatch;
  }

  /**
   * Recherche un manga sur Mangapill
   */
  private async searchManga(query: string): Promise<MangapillSearchResult[]> {
    try {
      const searchUrl = `${this.baseApiUrl}/${encodeURIComponent(query)}`;
      console.log(`Searching Mangapill: ${searchUrl}`);

      const response = await fetch(searchUrl, {
        signal: scraperSignal(),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Search failed with status: ${response.status}`);
      }

      const data = await response.json();
      
      // Consumet retourne généralement { results: [...] }
      const results = data.results || [];
      console.log(`Found ${results.length} results for "${query}"`);
      
      return results;
    } catch (error) {
      console.error("Error searching Mangapill:", error);
      throw error;
    }
  }

  /**
   * Récupère les informations détaillées d'un manga, y compris les chapitres
   */
  private async getMangaInfo(mangaId: string): Promise<MangapillMangaInfo | null> {
    try {
      const infoUrl = `${this.baseApiUrl}/info?id=${encodeURIComponent(mangaId)}`;
      console.log(`Fetching manga info: ${infoUrl}`);

      const response = await fetch(infoUrl, {
        signal: scraperSignal(),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch manga info with status: ${response.status}`
        );
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Error fetching manga info:", error);
      throw error;
    }
  }

  /**
   * Convertit les chapitres Mangapill en format ScrapedChapter
   */
  private convertToScrapedChapters(
    chapters: MangapillChapter[]
  ): ScrapedChapter[] {
    return chapters.map((chapter) => {
      // Extraire le numéro de chapitre depuis l'ID ou le titre
      let chapterNumber = 0;
      
      // Essayer d'extraire depuis le titre
      const titleMatch = chapter.title.match(/chapter[:\s]*(\d+(?:\.\d+)?)/i);
      if (titleMatch) {
        chapterNumber = parseFloat(titleMatch[1]);
      } else {
        // Essayer d'extraire depuis l'ID
        const idMatch = chapter.id.match(/chapter-(\d+(?:-\d+)?)/i);
        if (idMatch) {
          chapterNumber = parseFloat(idMatch[1].replace("-", "."));
        }
      }

      // Construire le lien avec /chapters/ avant l'ID
      // Si l'ID commence déjà par /, on l'utilise tel quel
      // Sinon, on ajoute /chapters/ avant
      let chapterLink: string;
      if (chapter.id.startsWith("/chapters/")) {
        chapterLink = `https://mangapill.com${chapter.id}`;
      } else if (chapter.id.startsWith("/")) {
        chapterLink = `https://mangapill.com/chapters${chapter.id}`;
      } else {
        chapterLink = `https://mangapill.com/chapters/${chapter.id}`;
      }

      return {
        chapter_number: chapterNumber,
        link: chapterLink,
        release_date: chapter.releaseDate || null,
      };
    });
  }

  /**
   * Méthode principale pour scraper les chapitres
   */
  async scrapeChapters(
    mangaTitle: string,
    malId?: number,
    titleSynonyms?: string[]
  ): Promise<ScrapedChapter[]> {
    try {
      console.log(`Scraping Mangapill for: ${mangaTitle}${malId ? ` (MAL ID: ${malId})` : ""}`);

      // Étape 1: Rechercher le manga
      const searchResults = await this.searchManga(mangaTitle);
      if (searchResults.length === 0) {
        console.log(`No manga found for "${mangaTitle}" on Mangapill`);
        return [];
      }

      // Étape 2: Trouver le meilleur match
      const bestMatch = this.findBestMatch(mangaTitle, searchResults, titleSynonyms);
      if (!bestMatch) {
        console.log(`No suitable match found for "${mangaTitle}"`);
        return [];
      }

      console.log(`Best match: ${bestMatch.title} (ID: ${bestMatch.id})`);

      // Étape 3: Récupérer les informations du manga et les chapitres
      const mangaInfo = await this.getMangaInfo(bestMatch.id);
      if (!mangaInfo || !mangaInfo.chapters || mangaInfo.chapters.length === 0) {
        console.log(`No chapters found for "${bestMatch.title}"`);
        return [];
      }

      console.log(`Found ${mangaInfo.chapters.length} chapters`);

      // Étape 4: Convertir en format standard
      const scrapedChapters = this.convertToScrapedChapters(
        mangaInfo.chapters
      );

      return scrapedChapters;
    } catch (error) {
      console.error("Error scraping Mangapill:", error);
      throw error;
    }
  }
}

// Export singleton instance
export const mangaPillScraper = new MangaPillScraper();

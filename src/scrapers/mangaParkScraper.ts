import { ScrapedChapter } from "../types";
import * as cheerio from "cheerio";

export interface MangaParkSearchResult {
  title: string;
  url: string;
}

export class MangaParkScraper {
  private baseUrl = "https://mangapark.io";

  /**
   * Main method to scrape chapters for a manga title
   * @param mangaTitle - Titre du manga
   * @param malId - MAL ID (non utilisé par MangaPark, mais requis par l'interface)
   * @param titleSynonyms - Optional array of alternative titles (not used by MangaPark)
   */
  async scrapeChapters(mangaTitle: string, malId?: number, _titleSynonyms?: string[]): Promise<ScrapedChapter[]> {
    // Use unused parameter to satisfy linter/TS for interface compatibility
    void _titleSynonyms;
    try {
      console.log(`Scraping MangaPark for: ${mangaTitle}${malId ? ` (MAL ID: ${malId})` : ''}`);

      // Step 1: Search for the manga
      const searchResults = await this.searchManga(mangaTitle);
      if (searchResults.length === 0) {
        console.log(`No manga found for "${mangaTitle}" on MangaPark`);
        return [];
      }

      // Step 2: Find the best match
      const bestMatch = this.findBestMatch(mangaTitle, searchResults);
      if (!bestMatch) {
        console.log(`No suitable match found for "${mangaTitle}"`);
        return [];
      }

      console.log(`Best match: ${bestMatch.title} - ${bestMatch.url}`);

      // Step 3: Get chapters from the manga page
      return await this.getChapters(bestMatch.url);
    } catch (error) {
      console.error("Error scraping MangaPark:", error);
      return [];
    }
  }

  /**
   * Search for manga on MangaPark
   */
  private async searchManga(title: string): Promise<MangaParkSearchResult[]> {
    try {
      const searchQuery = title.trim();
      // Format: https://mangapark.io/search?word=TITLE&lang=en&sortby=field_score&page=1
      const searchUrl = `${this.baseUrl}/search?word=${encodeURIComponent(
        searchQuery
      )}&lang=en&sortby=field_score&page=1`;

      console.log(`Searching MangaPark: ${searchUrl}`);

      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          Connection: "keep-alive",
        },
      });

      if (!response.ok) {
        throw new Error(`Search failed with status: ${response.status}`);
      }

      const html = await response.text();
      const results = this.parseSearchResults(html);

      // For MangaPark we do NOT fallback to keyword-based searches.
      // If the full-title search returns no results, return empty immediately.
      return results;
    } catch (error) {
      console.error("Error searching MangaPark:", error);
      return [];
    }
  }

  /**
   * Parse search results HTML
   */
  private parseSearchResults(html: string): MangaParkSearchResult[] {
    const $ = cheerio.load(html);
    const results: MangaParkSearchResult[] = [];

    try {
      console.log(`[DEBUG] HTML length: ${html.length} chars`);
      
      // MangaPark utilise des sélecteurs spécifiques pour les résultats de recherche
      const selectors = [
        'div[class*="flex border-b border-b-base-200 pb-5"]',
      ];

      let items = null;

      for (const selector of selectors) {
        const foundItems = $(selector);
        if (foundItems.length > 0) {
          items = foundItems;
          console.log(`[DEBUG] Found ${foundItems.length} items with selector: "${selector}"`);
          break;
        }
      }

      if (!items || items.length === 0) {
        console.warn("[DEBUG] No items found, trying all manga links...");
        items = $('a[href*="/title/"]');
        console.log(`[DEBUG] Using fallback selector: a[href*="/title/"]`);
      }

      const seenUrls = new Set<string>();

      items.each((index, element) => {
        const $el = $(element);
        
        // Si c'est un lien direct
        let $link = $el;
        if (!$el.is('a')) {
          $link = $el.find('a[href*="/title/"]').first();
        }

        const href = $link.attr("href");
        if (!href || !href.includes("/title/")) return;

        // Construire l'URL complète
        const fullUrl = href.startsWith("http")
          ? href
          : `${this.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

        // Éviter les doublons
        if (seenUrls.has(fullUrl)) return;
        seenUrls.add(fullUrl);

        // Extraire le titre
        let title = $link.text().trim();
        
        // Si le titre est vide, chercher dans les éléments enfants
        if (!title) {
          title = $el.find('.title, .name, h3, h4').first().text().trim();
        }

        if (!title) {
          title = $link.attr('title') || '';
        }

        if (title && fullUrl) {
          results.push({ title, url: fullUrl });
          console.log(`[DEBUG] Found result: ${title} - ${fullUrl}`);
        }
      });

      console.log(`[DEBUG] Total results found: ${results.length}`);
      return results;
    } catch (error) {
      console.error("[ERROR] Failed to parse search results:", error);
      return [];
    }
  }

  /**
   * Extract meaningful keywords from title for fallback search
   */
  private extractKeywords(title: string): string {
    // Supprimer les caractères spéciaux et garder les mots significatifs
    const words = title
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);

    if (words.length === 0) return title;

    // Prendre les 3 premiers mots significatifs
    return words.slice(0, 3).join(' ');
  }

  /**
   * Find best match using fuzzy string matching
   */
  private findBestMatch(
    searchQuery: string,
    results: MangaParkSearchResult[]
  ): MangaParkSearchResult | null {
    if (results.length === 0) return null;

    const normalizedQuery = this.normalizeTitle(searchQuery);
    const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 0);
    const isSingleWord = queryWords.length === 1;
    
    let bestMatch: MangaParkSearchResult | null = null;
    let highestScore = 0;

    for (const result of results) {
      const normalizedTitle = this.normalizeTitle(result.title);
      
      // Pour les titres à 1 mot, exiger que le titre complet soit exactement le mot recherché
      if (isSingleWord) {
        // Le titre doit être exactement le mot recherché (pas de mots supplémentaires)
        if (normalizedTitle === normalizedQuery) {
          console.log(`[DEBUG] Perfect exact match found for single word "${searchQuery}": ${result.title}`);
          return result;
        }

        // Si le titre affiché contient des mots supplémentaires (ex: "Real Man"),
        // vérifier également le slug dans l'URL (/title/slug). Le slug est souvent
        // plus fidèle au titre canonique. Exemple: /title/real ou /title/real-man
        try {
          const slugMatch = result.url.match(/\/title\/([^\/?#]+)/i);
          if (slugMatch && slugMatch[1]) {
            const rawSlug = decodeURIComponent(slugMatch[1]).replace(/[-_]+/g, ' ');
            const normalizedSlug = this.normalizeTitle(rawSlug);
            if (normalizedSlug === normalizedQuery) {
              console.log(`[DEBUG] Exact slug match found for single word "${searchQuery}": ${result.title} (slug: ${rawSlug})`);
              return result;
            }
          }
        } catch {
          // Ignore URL parsing errors and continue
        }

        console.log(`[DEBUG] Skipping "${result.title}" (normalized: "${normalizedTitle}") - not an exact match for "${normalizedQuery}"`);
        continue;
      }
      
      // Pour les titres multi-mots, utiliser la similarité
      const score = this.calculateSimilarity(normalizedQuery, normalizedTitle);

      console.log(`[DEBUG] Match score for "${result.title}": ${score.toFixed(2)}`);

      if (score > highestScore) {
        highestScore = score;
        bestMatch = result;
      }
    }

    // Pour les mots simples, si aucun match exact n'a été trouvé, retourner null
    if (isSingleWord) {
      console.log(`[DEBUG] No exact match found for single word "${searchQuery}"`);
      return null;
    }

    // Pour les titres multi-mots, seuil de 0.4 pour accepter un match
    if (highestScore >= 0.4) {
      console.log(`[DEBUG] Best match found with score: ${highestScore.toFixed(2)}`);
      return bestMatch;
    }

    console.log(`[DEBUG] No match above threshold (best score: ${highestScore.toFixed(2)})`);
    return null;
  }

  /**
   * Get chapters from manga page
   */
  private async getChapters(mangaUrl: string): Promise<ScrapedChapter[]> {
    try {
      console.log(`Fetching chapters from: ${mangaUrl}`);

      const response = await fetch(mangaUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          Connection: "keep-alive",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch manga page: ${response.status}`);
      }

      const html = await response.text();
      return this.parseChapters(html);
    } catch (error) {
      console.error("Error fetching chapters:", error);
      return [];
    }
  }

  /**
   * Parse chapters from manga page HTML
   */
  private parseChapters(html: string): ScrapedChapter[] {
    const $ = cheerio.load(html);
    const chapters: ScrapedChapter[] = [];

    try {
      // MangaPark utilise généralement une liste de chapitres
      const chapterSelectors = [
        'div.group.flex.flex-col > div'
      ];

      let chapterElements = null;

      for (const selector of chapterSelectors) {
        const elements = $(selector);
        if (elements.length > 0) {
          chapterElements = elements;
          console.log(`[DEBUG] Found ${elements.length} chapters with selector: "${selector}"`);
          break;
        }
      }

      if (!chapterElements || chapterElements.length === 0) {
        console.warn("[DEBUG] No chapters found with specific selectors, trying fallback...");
        chapterElements = $('a[href*="/chapter/"]');
      }

      const seenChapters = new Set<string>();
      const seenChapterNumbers = new Set<number>();

      chapterElements.each((index, element) => {
        const $el = $(element);
        
        // Trouver le lien du chapitre
        let $link = $el;
        if (!$el.is('a')) {
          $link = $el.find('a[href*="/title/"]').first();
        }

        const href = $link.attr("href");
        if (!href || !href.includes("/title/")) return;

        // Construire l'URL complète
        const chapterUrl = href.startsWith("http")
          ? href
          : `${this.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

        // Éviter les doublons par URL
        if (seenChapters.has(chapterUrl)) return;

        // Extraire le numéro de chapitre
        const chapterNumber = this.extractChapterNumber($el, $link);
        if (chapterNumber === null) return;

        // Éviter les doublons par numéro de chapitre
        if (seenChapterNumbers.has(chapterNumber)) {
          console.log(`[DEBUG] Skipping duplicate chapter number: ${chapterNumber}`);
          return;
        }

        seenChapters.add(chapterUrl);
        seenChapterNumbers.add(chapterNumber);

        // Extraire la date de publication si disponible
        const releaseDate = this.extractReleaseDate($el);

        chapters.push({
          chapter_number: chapterNumber,
          link: chapterUrl,
          release_date: releaseDate,
        });
      });

      // Déduplication finale par numéro de chapitre (garde le premier trouvé)
      const uniqueChapters = chapters.filter(
        (chapter, index, self) =>
          index ===
          self.findIndex((c) => c.chapter_number === chapter.chapter_number)
      );

      // Trier par numéro de chapitre (décroissant)
      uniqueChapters.sort((a, b) => b.chapter_number - a.chapter_number);

      console.log(`[DEBUG] Total unique chapters found: ${uniqueChapters.length}${uniqueChapters.length !== chapters.length ? ` (${chapters.length - uniqueChapters.length} duplicates removed)` : ''}`);
      return uniqueChapters;
    } catch (error) {
      console.error("[ERROR] Failed to parse chapters:", error);
      return [];
    }
  }

  /**
   * Extract chapter number from element
   */
  private extractChapterNumber($el: cheerio.Cheerio, $link: cheerio.Cheerio): number | null {
    // Chercher dans le texte du lien
    let text = $link.text().trim();
    
    // Si vide, chercher dans les éléments parents
    if (!text) {
      text = $el.text().trim();
    }

    // Patterns pour extraire le numéro de chapitre
    const patterns = [
      /chapter\s*(\d+(?:\.\d+)?)/i,
      /ch\.?\s*(\d+(?:\.\d+)?)/i,
      /ep\.?\s*(\d+(?:\.\d+)?)/i,
      /\b(\d+(?:\.\d+)?)\b/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const number = parseFloat(match[1]);
        if (!isNaN(number)) {
          return number;
        }
      }
    }

    // Essayer d'extraire depuis l'URL
    const urlMatch = $link.attr("href")?.match(/chapter[/-](\d+(?:\.\d+)?)/i);
    if (urlMatch) {
      const number = parseFloat(urlMatch[1]);
      if (!isNaN(number)) {
        return number;
      }
    }

    return null;
  }

  /**
   * Extract release date from element
   */
  private extractReleaseDate($el: cheerio.Cheerio): string | null {
    try {
      // Chercher des éléments de date communs
      const dateSelectors = [
        '.date',
        '.time',
        '.release-date',
        'time',
        '[datetime]',
      ];

      for (const selector of dateSelectors) {
        const $dateEl = $el.find(selector).first();
        if ($dateEl.length > 0) {
          // Chercher un attribut datetime
          const datetime = $dateEl.attr('datetime');
          if (datetime) {
            return new Date(datetime).toISOString();
          }

          // Sinon, parser le texte
          const dateText = $dateEl.text().trim();
          if (dateText) {
            const date = this.parseRelativeDate(dateText);
            if (date) {
              return date.toISOString();
            }
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse relative dates like "2 hours ago", "3 days ago"
   */
  private parseRelativeDate(dateText: string): Date | null {
    const now = new Date();

    // Pattern: "X time_unit ago"
    const patterns = [
      { regex: /(\d+)\s*second[s]?\s*ago/i, unit: 'seconds' },
      { regex: /(\d+)\s*minute[s]?\s*ago/i, unit: 'minutes' },
      { regex: /(\d+)\s*hour[s]?\s*ago/i, unit: 'hours' },
      { regex: /(\d+)\s*day[s]?\s*ago/i, unit: 'days' },
      { regex: /(\d+)\s*week[s]?\s*ago/i, unit: 'weeks' },
      { regex: /(\d+)\s*month[s]?\s*ago/i, unit: 'months' },
      { regex: /(\d+)\s*year[s]?\s*ago/i, unit: 'years' },
    ];

    for (const { regex, unit } of patterns) {
      const match = dateText.match(regex);
      if (match) {
        const value = parseInt(match[1]);
        const date = new Date(now);

        switch (unit) {
          case 'seconds':
            date.setSeconds(date.getSeconds() - value);
            break;
          case 'minutes':
            date.setMinutes(date.getMinutes() - value);
            break;
          case 'hours':
            date.setHours(date.getHours() - value);
            break;
          case 'days':
            date.setDate(date.getDate() - value);
            break;
          case 'weeks':
            date.setDate(date.getDate() - value * 7);
            break;
          case 'months':
            date.setMonth(date.getMonth() - value);
            break;
          case 'years':
            date.setFullYear(date.getFullYear() - value);
            break;
        }

        return date;
      }
    }

    // Essayer de parser comme date normale
    try {
      const parsed = new Date(dateText);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    } catch {
      // Ignore
    }

    return null;
  }

  /**
   * Normalize title for comparison (remove special chars, lowercase, etc.)
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Calculate similarity between two strings using Dice coefficient
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const bigrams1 = this.getBigrams(str1);
    const bigrams2 = this.getBigrams(str2);

    if (bigrams1.size === 0 || bigrams2.size === 0) {
      return str1 === str2 ? 1 : 0;
    }

    const intersection = new Set(
      [...bigrams1].filter(x => bigrams2.has(x))
    );

    return (2 * intersection.size) / (bigrams1.size + bigrams2.size);
  }

  /**
   * Get bigrams from a string for similarity calculation
   */
  private getBigrams(str: string): Set<string> {
    const bigrams = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.substring(i, i + 2));
    }
    return bigrams;
  }
}

// Export singleton instance
export const mangaParkScraper = new MangaParkScraper();

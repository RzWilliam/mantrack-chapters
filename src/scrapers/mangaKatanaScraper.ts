import { ScrapedChapter } from "../types";
import { scraperSignal } from "../lib/http";
import * as cheerio from "cheerio";

export interface MangaKatanaSearchResult {
  title: string;
  url: string;
  verifiedMatch?: boolean; // Indicates this result was verified via alt_name check
}

export class MangaKatanaScraper {
  private baseUrl = "https://mangakatana.com";

  /**
   * Helper method to add delay between requests
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main method to scrape chapters for a manga title
   * @param mangaTitle - Titre du manga
   * @param malId - MAL ID (non utilisé par MangaKatana, mais requis par l'interface)
   * @param titleSynonyms - Optional array of alternative titles
   * @param titleEnglish - Optional English title to try as fallback
   */
  async scrapeChapters(mangaTitle: string, malId?: number, titleSynonyms?: string[], titleEnglish?: string): Promise<ScrapedChapter[]> {
    try {
      console.log(`Scraping MangaKatana for: ${mangaTitle}${malId ? ` (MAL ID: ${malId})` : ''}`);

      // Prepare all title variants for verification
      const allTitleVariants = [mangaTitle];
      if (titleEnglish) allTitleVariants.push(titleEnglish);
      if (titleSynonyms) allTitleVariants.push(...titleSynonyms);

      // Step 1: Search for the manga with main title
      let searchResults = await this.searchManga(mangaTitle, allTitleVariants);
      
      // Step 2: If no results and titleEnglish is provided, try with English title
      if (searchResults.length === 0 && titleEnglish && titleEnglish !== mangaTitle) {
        console.log(`No results with main title, trying English title: ${titleEnglish}`);
        // Add delay to avoid getting blank 200 responses
        await this.sleep(5000);
        searchResults = await this.searchManga(titleEnglish, allTitleVariants);
      }
      
      // Step 3: If no results and no titleEnglish (or titleEnglish === mangaTitle), try first synonym
      if (searchResults.length === 0 && (!titleEnglish || titleEnglish === mangaTitle) && titleSynonyms && titleSynonyms.length > 0) {
        const firstSynonym = titleSynonyms[0];
        if (firstSynonym !== mangaTitle) {
          console.log(`No results with main title, trying first synonym: ${firstSynonym}`);
          // Add delay to avoid getting blank 200 responses
          await this.sleep(5000);
          searchResults = await this.searchManga(firstSynonym, allTitleVariants);
        }
      }
      
      if (searchResults.length === 0) {
        console.log(`No manga found for "${mangaTitle}" on MangaKatana`);
        return [];
      }

      // Step 3: Check if we have a verified direct match (from redirect)
      const verifiedMatch = searchResults.find(r => r.verifiedMatch);
      if (verifiedMatch) {
        console.log(`Using verified direct match: ${verifiedMatch.title} - ${verifiedMatch.url}`);
        return await this.getChapters(verifiedMatch.url);
      }

      // Step 4: Find the best match from search results
      const allTitles = [mangaTitle];
      if (titleEnglish) allTitles.push(titleEnglish);
      if (titleSynonyms) allTitles.push(...titleSynonyms);
      
      const bestMatch = this.findBestMatch(allTitles, searchResults);
      if (!bestMatch) {
        console.log(`No suitable match found for "${mangaTitle}"`);
        return [];
      }

      console.log(`Best match: ${bestMatch.title} - ${bestMatch.url}`);

      // Step 5: Get chapters from the manga page
      return await this.getChapters(bestMatch.url);
    } catch (error) {
      console.error("Error scraping MangaKatana:", error);
      throw error;
    }
  }

  /**
   * Search for manga on MangaKatana
   */
  private async searchManga(title: string, allTitleVariants?: string[]): Promise<MangaKatanaSearchResult[]> {
    try {
      const searchQuery = title.trim();
      // Format: https://mangakatana.com/?search=Test&search_by=book_name
      const searchUrl = `${this.baseUrl}/?search=${encodeURIComponent(
        searchQuery
      )}&search_by=book_name`;

      console.log(`Searching MangaKatana: ${searchUrl}`);

      const response = await fetch(searchUrl, {
        signal: scraperSignal(),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          Connection: "keep-alive",
        },
        redirect: 'manual', // Handle redirects manually to detect direct matches
      });

      // If redirected (status 301, 302, 303, 307, 308), it's a direct match
      if (response.status >= 300 && response.status < 400) {
        const redirectUrl = response.headers.get('location');
        if (redirectUrl) {
          console.log(`Direct match - redirected to: ${redirectUrl}`);
          
          // Build full URL if it's relative
          const fullRedirectUrl = redirectUrl.startsWith('http') 
            ? redirectUrl 
            : `${this.baseUrl}${redirectUrl.startsWith('/') ? '' : '/'}${redirectUrl}`;
          
          // Verify the match by checking alternative titles on the manga page
          const isValidMatch = await this.verifyMangaMatch(fullRedirectUrl, title, allTitleVariants);
          
          if (isValidMatch) {
            // Extract title from URL or use search query as fallback
            const urlMatch = fullRedirectUrl.match(/\/manga\/([^/]+)/);
            const titleFromUrl = urlMatch 
              ? decodeURIComponent(urlMatch[1]).replace(/-/g, ' ').replace(/\.\d+$/, '').trim()
              : searchQuery;
            
            return [{
              title: titleFromUrl,
              url: fullRedirectUrl,
              verifiedMatch: true // Mark as verified to skip findBestMatch
            }];
          } else {
            console.log(`Redirect found but manga doesn't match search criteria`);
            return [];
          }
        }
      }

      if (!response.ok && response.status !== 301 && response.status !== 302 && response.status !== 303 && response.status !== 307 && response.status !== 308) {
        throw new Error(`Search failed with status: ${response.status}`);
      }

      const html = await response.text();
      const results = this.parseSearchResults(html);

      return results;
    } catch (error) {
      console.error("Error searching MangaKatana:", error);
      throw error;
    }
  }

  /**
   * Parse search results HTML
   */
  private parseSearchResults(html: string): MangaKatanaSearchResult[] {
    const $ = cheerio.load(html);
    const results: MangaKatanaSearchResult[] = [];

    try {
      console.log(`[DEBUG] HTML length: ${html.length} chars`);
      
      // MangaKatana uses #book_list .item for search results
      const items = $('#book_list .item');
      
      console.log(`[DEBUG] Found ${items.length} items with selector: #book_list .item`);

      if (items.length === 0) {
        console.warn("[DEBUG] No items found with #book_list .item");
        return [];
      }

      const seenUrls = new Set<string>();

      items.each((index, element) => {
        const $el = $(element);
        
        // Title and URL are in .title a
        const $link = $el.find('.title a').first();
        
        const href = $link.attr("href");
        if (!href) return;

        // Construire l'URL complète
        const fullUrl = href.startsWith("http")
          ? href
          : `${this.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

        // Éviter les doublons
        if (seenUrls.has(fullUrl)) return;
        seenUrls.add(fullUrl);

        // Extraire le titre
        const title = $link.text().trim();

        if (title && fullUrl) {
          results.push({ title, url: fullUrl });
          console.log(`[DEBUG] Found result: ${title} - ${fullUrl}`);
        }
      });

      console.log(`[DEBUG] Total results found: ${results.length}`);
      return results;
    } catch (error) {
      console.error("[ERROR] Failed to parse search results:", error);
      throw error;
    }
  }

  /**
   * Find best match using fuzzy string matching
   * @param searchTitles - Array of titles to try matching (main title, English title, synonyms)
   * @param results - Search results from MangaKatana
   */
  private findBestMatch(
    searchTitles: string[],
    results: MangaKatanaSearchResult[]
  ): MangaKatanaSearchResult | null {
    if (results.length === 0) return null;

    let bestMatch: MangaKatanaSearchResult | null = null;
    let highestScore = 0;

    // Try each search title
    for (const searchQuery of searchTitles) {
      const normalizedQuery = this.normalizeTitle(searchQuery);
      const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 0);
      const isSingleWord = queryWords.length === 1;
      
      for (const result of results) {
        const normalizedTitle = this.normalizeTitle(result.title);
        
        // Pour les titres à 1 mot, exiger une correspondance exacte
        if (isSingleWord) {
          if (normalizedTitle === normalizedQuery) {
            console.log(`[DEBUG] Perfect exact match found for single word "${searchQuery}": ${result.title}`);
            return result;
          }

          // Vérifier aussi le slug dans l'URL
          try {
            const slugMatch = result.url.match(/\/manga\/([^/?#.]+)/i);
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

        console.log(`[DEBUG] Match score for "${result.title}" vs "${searchQuery}": ${score.toFixed(2)}`);

        if (score > highestScore) {
          highestScore = score;
          bestMatch = result;
        }
      }
      
      // If we found a good match with this title, stop searching
      if (highestScore >= 0.7) {
        console.log(`[DEBUG] Strong match found with "${searchQuery}", stopping search`);
        break;
      }
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
   * Verify if a manga page matches the search criteria by checking alternative titles
   * @param mangaUrl - URL of the manga page
   * @param searchTitle - The title we searched for
   * @param allTitleVariants - All title variants (main, English, synonyms) to check against
   */
  private async verifyMangaMatch(mangaUrl: string, searchTitle: string, allTitleVariants?: string[]): Promise<boolean> {
    try {
      console.log(`[DEBUG] Verifying manga match for: ${mangaUrl}`);
      
      const response = await fetch(mangaUrl, {
      
        signal: scraperSignal(),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          Connection: "keep-alive",
        },
      });

      if (!response.ok) {
        console.warn(`[DEBUG] Failed to fetch manga page for verification: ${response.status}`);
        return true; // Assume it's valid if we can't verify
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Extract alternative titles from .alt_name
      // Format: "尾守つみきと奇日常。 ; Ogami Tsumiki to Kinichijou. ; Tsumiki Ogami's Not-So-Ordinary Life"
      const altNameElement = $('.alt_name');
      
      if (altNameElement.length === 0) {
        console.log(`[DEBUG] No .alt_name found, accepting match`);
        return true; // No alt names to check, accept the match
      }

      const altNamesText = altNameElement.text().trim();
      console.log(`[DEBUG] Found alt_name: ${altNamesText}`);

      // Split by semicolon and trim each title
      const alternativeTitles = altNamesText
        .split(';')
        .map(title => title.trim())
        .filter(title => title.length > 0);

      console.log(`[DEBUG] Parsed ${alternativeTitles.length} alternative titles`);

      // Also get the main title from the page
      const mainTitle = $('.info .heading').text().trim() || $('h1').first().text().trim();
      if (mainTitle) {
        alternativeTitles.unshift(mainTitle);
        console.log(`[DEBUG] Main title from page: ${mainTitle}`);
      }

      // Use all title variants for comparison (includes main title, English title, and synonyms)
      const searchTitles = allTitleVariants 
        ? allTitleVariants.map(t => this.normalizeTitle(t))
        : [this.normalizeTitle(searchTitle)];

      console.log(`[DEBUG] Checking against ${searchTitles.length} search title variants`);

      // Check if any alternative title matches any search title
      for (const altTitle of alternativeTitles) {
        const normalizedAltTitle = this.normalizeTitle(altTitle);
        
        for (const searchTitle of searchTitles) {
          // Check for exact match
          if (normalizedAltTitle === searchTitle) {
            console.log(`[DEBUG] ✓ Exact match found: "${altTitle}" matches "${searchTitle}"`);
            return true;
          }

          // Check for high similarity
          const similarity = this.calculateSimilarity(normalizedAltTitle, searchTitle);
          if (similarity >= 0.7) {
            console.log(`[DEBUG] ✓ High similarity match: "${altTitle}" vs "${searchTitle}" (score: ${similarity.toFixed(2)})`);
            return true;
          }
        }
      }

      console.log(`[DEBUG] ✗ No matching alternative titles found`);
      return false;
    } catch (error) {
      console.error(`[DEBUG] Error verifying manga match:`, error);
      return true; // Assume it's valid if there's an error
    }
  }

  /**
   * Get chapters from manga page
   */
  private async getChapters(mangaUrl: string): Promise<ScrapedChapter[]> {
    try {
      console.log(`Fetching chapters from: ${mangaUrl}`);

      const response = await fetch(mangaUrl, {
        signal: scraperSignal(),
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
      throw error;
    }
  }

  /**
   * Parse chapters from manga page HTML
   */
  private parseChapters(html: string): ScrapedChapter[] {
    const $ = cheerio.load(html);
    const chapters: ScrapedChapter[] = [];

    try {
      // MangaKatana uses .chapters .chapter for chapter list
      const chapterElements = $('.chapters .chapter');

      console.log(`[DEBUG] Found ${chapterElements.length} chapters with selector: .chapters .chapter`);

      if (chapterElements.length === 0) {
        console.warn("[DEBUG] No chapters found with selector .chapters .chapter");
        return [];
      }

      const seenChapters = new Set<string>();
      const seenChapterNumbers = new Set<number>();

      chapterElements.each((index, element) => {
        const $el = $(element);
        
        // Find the chapter link
        const $link = $el.find('a').first();
        if ($link.length === 0) return;

        const href = $link.attr("href");
        if (!href) return;

        // Build full URL
        const chapterUrl = href.startsWith("http")
          ? href
          : `${this.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

        // Avoid duplicates by URL
        if (seenChapters.has(chapterUrl)) return;

        // Extract chapter number
        const chapterNumber = this.extractChapterNumber($el, $link);
        if (chapterNumber === null) return;

        // Avoid duplicates by chapter number
        if (seenChapterNumbers.has(chapterNumber)) {
          console.log(`[DEBUG] Skipping duplicate chapter number: ${chapterNumber}`);
          return;
        }

        seenChapters.add(chapterUrl);
        seenChapterNumbers.add(chapterNumber);

        // Extract release date if available
        const releaseDate = this.extractReleaseDate($el);

        chapters.push({
          chapter_number: chapterNumber,
          link: chapterUrl,
          release_date: releaseDate,
        });
      });

      // Sort by chapter number (descending)
      chapters.sort((a, b) => b.chapter_number - a.chapter_number);

      console.log(`[DEBUG] Total unique chapters found: ${chapters.length}`);
      return chapters;
    } catch (error) {
      console.error("[ERROR] Failed to parse chapters:", error);
      throw error;
    }
  }

  /**
   * Extract chapter number from element
   */
  private extractChapterNumber($el: cheerio.Cheerio, $link: cheerio.Cheerio): number | null {
    // Try from link text
    let text = $link.text().trim();
    
    // If empty, try from parent element
    if (!text) {
      text = $el.text().trim();
    }

    // Patterns to extract chapter number
    const patterns = [
      /chapter\s*(\d+(?:\.\d+)?)/i,
      /ch\.?\s*(\d+(?:\.\d+)?)/i,
      /ep\.?\s*(\d+(?:\.\d+)?)/i,
      /c(\d+(?:\.\d+)?)/i,
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

    // Try to extract from URL (e.g., /manga/title.12345/c62)
    const urlMatch = $link.attr("href")?.match(/[/c](\d+(?:\.\d+)?)$/i);
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
      // Look for common date elements
      const dateSelectors = [
        '.date',
        '.time',
        '.release-date',
        'time',
        '[datetime]',
        '.update_time',
      ];

      for (const selector of dateSelectors) {
        const $dateEl = $el.find(selector).first();
        if ($dateEl.length > 0) {
          // Look for datetime attribute
          const datetime = $dateEl.attr('datetime');
          if (datetime) {
            return new Date(datetime).toISOString();
          }

          // Otherwise, parse the text
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

    // Try to parse as normal date
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
export const mangaKatanaScraper = new MangaKatanaScraper();

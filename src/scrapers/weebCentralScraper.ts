import { ScrapedChapter } from "../types";
import { SCRAPER_TIMEOUT_MS } from "../lib/http";
import { MangaScraper } from "./types";
import { load } from "cheerio";

const BASE_URL = "https://weebcentral.com";

interface SearchResult {
  id: string;
  title: string;
  [key: string]: unknown;
}

interface MangaChapter {
  id: string;
  title?: string;
  chapterNumber?: string | number;
  releaseDate?: string;
  [key: string]: unknown;
}

/**
 * Scraper pour Weeb Central utilisant got-scraping
 *
 * got-scraping reproduit le fingerprint TLS/HTTP2 d'un vrai navigateur,
 * ce qui contourne le blocage Cloudflare des IPs GitHub Actions sans
 * avoir à lancer un browser headless complet.
 */
export class WeebCentralScraper implements MangaScraper {
  /**
   * got-scraping est ESM-only, on l'importe dynamiquement pour compatibilité
   * avec le contexte CommonJS/tsx du projet.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async got(): Promise<any> {
    const { gotScraping } = await import("got-scraping");
    return gotScraping;
  }

  /**
   * Main method to scrape chapters for a manga title
   */
  async scrapeChapters(
    mangaTitle: string,
    malId?: number,
    _titleSynonyms?: string[],
    titleEnglish?: string,
  ): Promise<ScrapedChapter[]> {
    try {
      console.log(
        `[Weeb Central] Searching for: ${mangaTitle}${malId ? ` (MAL ID: ${malId})` : ""}`,
      );

      const gotScraping = await this.got();
      const searchTitle = titleEnglish || mangaTitle;

      // Truncate at first special character for the API query
      // e.g. "The Swordmaster's Son" → search "The Swordmaster", match against full title
      const searchQuery = this.truncateAtSpecialChar(searchTitle);
      if (searchQuery !== searchTitle) {
        console.log(
          `[Weeb Central] Truncated query: "${searchTitle}" → "${searchQuery}"`,
        );
      }

      console.log(`[Weeb Central] Searching with query: "${searchQuery}"`);

      // Step 1: Search
      const searchParams = new URLSearchParams({
        limit: "32",
        offset: "0",
        text: searchQuery,
        sort: "Best Match",
        order: "Descending",
        official: "Any",
        anime: "Any",
        adult: "Any",
        display_mode: "Full Display",
      });

      const currentUrl = `${BASE_URL}/search?text=${encodeURIComponent(searchQuery)}&sort=Best+Match&order=Descending&official=Any&anime=Any&adult=Any&display_mode=Full+Display`;

      const searchResponse = await gotScraping.get(
        `${BASE_URL}/search/data?${searchParams}`,
        {
          headers: {
            "HX-Request": "true",
            "HX-Current-URL": currentUrl,
            Referer: `${BASE_URL}/`,
          },
          responseType: "text",
          // Borne la requête : got-scraping n'a pas de timeout par défaut, et sa
          // politique de retry (2 tentatives) multiplierait l'attente d'autant.
          timeout: { request: SCRAPER_TIMEOUT_MS },
          retry: { limit: 1 },
        },
      );

      const $search = load(searchResponse.body as string);
      const results: SearchResult[] = [];

      $search("article.bg-base-300").each((_, el) => {
        const href =
          $search(el).find("section a").first().attr("href") || "";
        const id = href.split("/series/")[1] || "";
        const title =
          $search(el)
            .find("section.hidden.lg\\:block .tooltip a")
            .text()
            .trim() ||
          $search(el).find("section a .text-ellipsis").text().trim();
        if (id && title) results.push({ id, title });
      });

      console.log(`[Weeb Central] Found ${results.length} results`);

      if (results.length === 0) return [];

      // Step 2: Find best match using full original title (not the truncated query)
      const bestMatch = this.findBestMatch(searchTitle, results);

      if (!bestMatch) {
        console.log(`[Weeb Central] No suitable match found`);
        return [];
      }

      console.log(
        `[Weeb Central] Best match: "${bestMatch.title}" (ID: ${bestMatch.id})`,
      );

      // Step 3: Fetch chapter list
      const cleanId = bestMatch.id.split("/")[0];
      const seriesUrl = `${BASE_URL}/series/${bestMatch.id}`;

      const chaptersResponse = await gotScraping.get(
        `${BASE_URL}/series/${cleanId}/full-chapter-list`,
        {
          headers: {
            "HX-Request": "true",
            "HX-Target": "chapter-list",
            "HX-Current-URL": seriesUrl,
            Referer: seriesUrl,
          },
          responseType: "text",
          // Borne la requête : got-scraping n'a pas de timeout par défaut, et sa
          // politique de retry (2 tentatives) multiplierait l'attente d'autant.
          timeout: { request: SCRAPER_TIMEOUT_MS },
          retry: { limit: 1 },
        },
      );

      const $chapters = load(chaptersResponse.body as string);
      const rawChapters: MangaChapter[] = [];

      $chapters('a[href*="/chapters/"]').each((_, el) => {
        const href = $chapters(el).attr("href") || "";
        const chapterId = href.split("/chapters/")[1];
        if (!chapterId) return;
        const title = $chapters(el).find("span.grow span").first().text().trim();
        const releaseDate = $chapters(el).find("time").attr("datetime") || "";
        rawChapters.push({ id: chapterId, title, releaseDate });
      });

      console.log(`[Weeb Central] Found ${rawChapters.length} chapters`);

      if (rawChapters.length === 0) return [];

      // Step 4: Map to ScrapedChapter
      const scrapedChapters: ScrapedChapter[] = rawChapters
        .map((chapter) => {
          const chapterNumber = this.extractChapterNumber(
            chapter.title || "",
            chapter.chapterNumber || "",
            chapter.id,
          );
          if (chapterNumber === null) return null;
          return {
            chapter_number: chapterNumber,
            link: `${BASE_URL}/chapters/${chapter.id}`,
            release_date: chapter.releaseDate
              ? this.parseReleaseDate(chapter.releaseDate)
              : null,
          };
        })
        .filter((ch): ch is ScrapedChapter => ch !== null);

      scrapedChapters.sort((a, b) => a.chapter_number - b.chapter_number);

      console.log(
        `[Weeb Central] Successfully scraped ${scrapedChapters.length} chapters`,
      );
      return scrapedChapters;
    } catch (error) {
      console.error("[Weeb Central] Error scraping chapters:", error);
      return [];
    }
  }

  /**
   * Truncate a title at the first special character for use as search query.
   * Keeps the truncated form only if it's long enough to be meaningful.
   *
   *   "The Swordmaster's Son" → "The Swordmaster"
   *   "Re:Zero"               → "Re:Zero"  (too short before ':')
   *   "Solo Leveling"         → "Solo Leveling"
   */
  private truncateAtSpecialChar(title: string): string {
    const match = title.match(/^([\w\s]+)/);
    const truncated = match ? match[1].trim() : title;
    return truncated.length >= 5 ? truncated : title;
  }

  /**
   * Find best match using title similarity
   */
  private findBestMatch(
    searchQuery: string,
    results: Array<{ id: string; title: string }>,
  ): { id: string; title: string } | null {
    if (results.length === 0) return null;

    const normalizedQuery = this.normalizeTitle(searchQuery);
    const queryWords = normalizedQuery.split(/\s+/).filter((w) => w.length > 0);

    let bestMatch: { id: string; title: string } | null = null;
    let highestScore = 0;

    for (const result of results) {
      const score = this.calculateSimilarity(
        normalizedQuery,
        this.normalizeTitle(result.title),
        queryWords,
      );
      if (score > highestScore) {
        highestScore = score;
        bestMatch = result;
      }
    }

    const threshold = queryWords.length === 1 ? 0.5 : 0.6;
    return highestScore >= threshold ? bestMatch : null;
  }

  private extractChapterNumber(
    title: string,
    chapterNumber: string | number,
    chapterId: string,
  ): number | null {
    if (typeof chapterNumber === "number") return chapterNumber;

    if (typeof chapterNumber === "string" && chapterNumber.trim() !== "") {
      const num = parseFloat(chapterNumber);
      if (!isNaN(num)) return num;
    }

    const patterns = [
      /chapter[:\s-]*(\d+(?:\.\d+)?)/i,
      /ch[:\s.-]*(\d+(?:\.\d+)?)/i,
      /episode[:\s-]*(\d+(?:\.\d+)?)/i,
      /ep[:\s.-]*(\d+(?:\.\d+)?)/i,
      /#(\d+(?:\.\d+)?)/,
      /\b(\d+(?:\.\d+)?)\b/,
    ];

    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match?.[1]) {
        const num = parseFloat(match[1]);
        if (!isNaN(num)) return num;
      }
    }

    const idMatch = chapterId.match(/(\d+(?:\.\d+)?)/);
    if (idMatch?.[1]) {
      const num = parseFloat(idMatch[1]);
      if (!isNaN(num)) return num;
    }

    return null;
  }

  private parseReleaseDate(releaseDate: string | Date): string | null {
    try {
      if (releaseDate instanceof Date) return releaseDate.toISOString();
      if (typeof releaseDate === "string") {
        const parsed = new Date(releaseDate);
        if (!isNaN(parsed.getTime())) return parsed.toISOString();
      }
    } catch {
      // ignore
    }
    return null;
  }

  private calculateSimilarity(
    query: string,
    title: string,
    queryWords: string[],
  ): number {
    if (query === title) return 1.0;
    if (title.includes(query)) return 0.95;

    const titleWords = title.split(/\s+/);
    let matchedWords = 0;
    for (const w of queryWords) {
      if (titleWords.some((t) => t.includes(w))) matchedWords++;
    }

    const wordScore = matchedWords / queryWords.length;
    const distance = this.levenshteinDistance(query, title);
    const distanceScore = 1 - distance / Math.max(query.length, title.length);

    return wordScore * 0.7 + distanceScore * 0.3;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) matrix[i] = [i];
    for (let j = 0; j <= str1.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        matrix[i][j] =
          str2[i - 1] === str1[j - 1]
            ? matrix[i - 1][j - 1]
            : Math.min(
                matrix[i - 1][j - 1] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j] + 1,
              );
      }
    }

    return matrix[str2.length][str1.length];
  }

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ");
  }
}

export const weebCentralScraper = new WeebCentralScraper();

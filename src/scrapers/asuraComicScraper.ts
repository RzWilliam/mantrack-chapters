import { ScrapedChapter } from "../types";
import { scraperSignal } from "../lib/http";
import * as cheerio from "cheerio";

export interface AsuraSearchResult {
  title: string;
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Déballe la sérialisation des props d'un îlot Astro.
 *
 * Astro n'envoie pas les props en JSON brut : chaque valeur est encodée en
 * `[type, valeur]` (`[0, 199]` pour un nombre, `[1, [...]]` pour un tableau dont
 * les éléments sont eux-mêmes encodés), et `[0]` seul vaut `null`/`undefined`.
 * Sans ce déballage, `chapters` est un tableau de tuples et `is_premium` vaut
 * `[0, true]` — jamais `true`.
 *
 * Le discriminant `typeof value[0] === "number"` suffit à distinguer un tuple
 * d'un vrai tableau : dans un tableau encodé, les éléments sont des tuples
 * (donc des tableaux), jamais des nombres nus.
 */
function unwrapAstroProps(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (typeof value[0] === "number") {
      return value.length > 1 ? unwrapAstroProps(value[1]) : null;
    }
    return value.map(unwrapAstroProps);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, unwrapAstroProps(entry)])
    );
  }

  return value;
}

export class AsuraComicScraper {
  private baseUrl = "https://asurascans.com";

  /**
   * Main method to scrape chapters for a manga title
   * @param mangaTitle - Titre du manga
   * @param malId - MAL ID (non utilisé par AsuraComic, mais requis par l'interface)
   * @param titleSynonyms - Optional array of alternative titles to try
   * @param titleEnglish - Optional English title
   */
  async scrapeChapters(mangaTitle: string, malId?: number, titleSynonyms?: string[], titleEnglish?: string): Promise<ScrapedChapter[]> {
    try {
      console.log(`Scraping AsuraComic for: ${mangaTitle}${malId ? ` (MAL ID: ${malId})` : ''}`);
      if (titleSynonyms && titleSynonyms.length > 0) {
        console.log(`Available synonyms: ${titleSynonyms.join(', ')}`);
      }

      // ⚠️ Depuis le contrat d'erreur (cf. `./types.ts`), `searchManga` LÈVE au lieu
      // de renvoyer `[]`. Or Asura enchaîne jusqu'à 4 recherches (titre, titre
      // anglais, synonyme, mots-clés) : laisser la 1re erreur remonter telle quelle
      // annulerait tous les replis — précisément là où cette série a ses chances.
      // On retient donc l'erreur et on ne la relance QUE si aucune tentative n'a
      // abouti : une panne reste visible, un hoquet ne coûte plus les replis.
      let lastSearchError: unknown = null;
      const trySearch = async (
        title: string,
        tryKeywords: boolean
      ): Promise<AsuraSearchResult[]> => {
        try {
          return await this.searchManga(title, tryKeywords);
        } catch (error) {
          lastSearchError = error;
          console.warn(`Asura search failed for "${title}":`, error);
          return [];
        }
      };

      // Step 1: Search for the manga with main title (no keyword fallback)
      let searchResults = await trySearch(mangaTitle, false);
      let titleUsedForSearch = mangaTitle;
      let bestMatch = searchResults.length > 0 ? this.findBestMatch(titleUsedForSearch, searchResults) : null;

      // Step 1.5: If no match and we have titleEnglish, try it (no keyword fallback)
      if (!bestMatch && titleEnglish && titleEnglish !== mangaTitle) {
        console.log(`No match with main title, trying English title: "${titleEnglish}"`);
        searchResults = await trySearch(titleEnglish, false);
        titleUsedForSearch = titleEnglish;

        if (searchResults.length > 0) {
          bestMatch = this.findBestMatch(titleUsedForSearch, searchResults);
          if (bestMatch) {
            console.log(`Found match using English title: "${titleUsedForSearch}"`);
          }
        }
      }

      // Step 1.75: If still no match (or titleEnglish was null/equal to title) and we have synonyms, try the first synonym (no keyword fallback)
      if (!bestMatch && titleSynonyms && titleSynonyms.length > 0) {
        const firstSynonym = titleSynonyms[0];
        console.log(`No match with main title${titleEnglish && titleEnglish !== mangaTitle ? ' or English title' : ''}, trying first synonym: "${firstSynonym}"`);
        searchResults = await trySearch(firstSynonym, false);
        titleUsedForSearch = firstSynonym;

        if (searchResults.length > 0) {
          bestMatch = this.findBestMatch(titleUsedForSearch, searchResults);
          if (bestMatch) {
            console.log(`Found match using synonym: "${titleUsedForSearch}"`);
          }
        }
      }

      // Step 2: If still no match, try keyword search with main title
      if (!bestMatch) {
        console.log(`No match with title${titleEnglish && titleEnglish !== mangaTitle ? ', English title' : ''}${titleSynonyms && titleSynonyms.length > 0 ? ', or synonym' : ''}, trying keyword search...`);
        searchResults = await trySearch(mangaTitle, true);
        titleUsedForSearch = mangaTitle; // Revenir au titre principal pour le matching

        if (searchResults.length > 0) {
          bestMatch = this.findBestMatch(titleUsedForSearch, searchResults);
        }
      }

      // Step 3: If still no match, give up
      if (!bestMatch) {
        // Aucune recherche n'a abouti ET au moins une a échoué : c'est une panne,
        // pas une absence. Le contrat impose de le dire.
        if (lastSearchError) throw lastSearchError;
        console.log(`No suitable match found for "${mangaTitle}" on AsuraComic`);
        return [];
      }

      console.log(`Best match: ${bestMatch.title} - ${bestMatch.url}`);

      // Step 4: Get chapters from the manga page
      return await this.getChapters(bestMatch.url);
    } catch (error) {
      console.error("Error scraping AsuraComic:", error);
      throw error;
    }
  }

  /**
   * Search for manga on AsuraComic
   */
  private async searchManga(title: string, tryKeywords: boolean = false): Promise<AsuraSearchResult[]> {
    try {
      // Essayer d'abord avec le titre original
      const searchQuery = title.trim();
      const searchUrl = `${this.baseUrl}/browse?search=${encodeURIComponent(
        searchQuery
      )}`;

      console.log(`Searching: ${searchUrl}`);

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
      });

      if (!response.ok) {
        throw new Error(`Search failed with status: ${response.status}`);
      }

      const html = await response.text();
      let results = this.parseSearchResults(html);

      // Si aucun résultat ET que tryKeywords est activé, essayer avec les mots-clés significatifs
      if (results.length === 0 && tryKeywords) {
        const keywords = this.getLongestWord(title);
        if (keywords && keywords !== title.trim()) {
          console.log(`No results with full title, trying keywords: "${keywords}"`);

          const retryUrl = `${this.baseUrl}/browse?search=${encodeURIComponent(
            keywords
          )}`;
          const retryResponse = await fetch(retryUrl, {
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

          if (retryResponse.ok) {
            const retryHtml = await retryResponse.text();
            results = this.parseSearchResults(retryHtml);
          }
        }
      }

      // Si toujours aucun résultat ET que tryKeywords est activé, essayer avec juste le mot le plus long
      if (results.length === 0 && tryKeywords) {
        const words = title
          .toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 4);

        if (words.length > 0) {
          const longestSingleWord = words.reduce((longest, current) =>
            current.length > longest.length ? current : longest
          );

          console.log(`Still no results, trying single word: "${longestSingleWord}"`);

          const singleWordUrl = `${this.baseUrl}/browse?search=${encodeURIComponent(
            longestSingleWord
          )}`;
          const singleWordResponse = await fetch(singleWordUrl, {
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

          if (singleWordResponse.ok) {
            const singleWordHtml = await singleWordResponse.text();
            results = this.parseSearchResults(singleWordHtml);
          }
        }
      }

      return results;
    } catch (error) {
      console.error("Error searching AsuraComic:", error);
      throw error;
    }
  }

  /**
   * Parse search results HTML
   */
  private parseSearchResults(html: string): AsuraSearchResult[] {
    const $ = cheerio.load(html);
    const results: AsuraSearchResult[] = [];

    try {
      console.log(`[DEBUG] HTML length: ${html.length} chars`);
      
      // Essayer plusieurs sélecteurs
      const selectors = [
        '.grid.grid-cols-2',
        '.grid',
        '[class*="grid"]',
        'div[class*="grid"]'
      ];

      let gridContainer = null;
      let usedSelector = '';

      for (const selector of selectors) {
        const container = $(selector);
        if (container.length > 0) {
          gridContainer = container;
          usedSelector = selector;
          console.log(`[DEBUG] Found container with selector: "${selector}"`);
          break;
        }
      }

      if (!gridContainer || gridContainer.length === 0) {
        console.warn("[DEBUG] No grid container found, trying all links...");
        gridContainer = $('body');
        usedSelector = 'body (fallback)';
      }

      // Compter tous les liens
      const allLinks = gridContainer.find('a[href*="comics/"]');
      console.log(`[DEBUG] Found ${allLinks.length} links containing "comics/" in ${usedSelector}`);

      // Chercher les liens uniquement dans ce conteneur
      allLinks.each((index, element) => {
        const $el = $(element);
        const href = $el.attr("href");

        if (!href || !href.includes("comics/")) return;

        // Exclure les liens vers les chapitres
        if (href.includes('/chapter/')) {
          console.log(`[DEBUG] Skipping chapter link: ${href}`);
          return;
        }

        const fullUrl = href.startsWith("http")
          ? href
          : href.startsWith("/")
          ? `${this.baseUrl}${href}`
          : `${this.baseUrl}/${href}`;

        // Obtenir le titre avec plusieurs méthodes
        let title = $el.attr("title") ||
                    $el.find("span.block.font-bold").text().trim() || // <-- ici
                    $el.find("img").attr("alt") ||
                    $el.find("img").attr("title") ||
                    $el.text().trim();

        if (title) {
          title = title.trim().replace(/\s+/g, ' ');
        }

        if (title && title.length > 0 && title.length < 200) {
          results.push({
            title: title,
            url: fullUrl,
          });
          if (index < 3) {
            console.log(`[DEBUG] Found result #${index + 1}: "${title}"`);
          }
        }
      });

      // Remove duplicates
      const uniqueResults = results.filter(
        (result, index, self) =>
          index === self.findIndex((r) => r.url === result.url)
      );

      console.log(`Found ${uniqueResults.length} unique search results`);
      
      // Afficher les premiers résultats
      if (uniqueResults.length > 0 && uniqueResults.length <= 3) {
        uniqueResults.forEach((r, i) => {
          console.log(`  ${i + 1}. ${r.title}`);
        });
      }

      return uniqueResults.slice(0, 10); // Augmenter à 10 pour plus de chances
    } catch (error) {
      console.error("Error parsing search results:", error);
      throw error;
    }
  }

  /**
   * Get chapters from a manga page
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
      return this.parseChapters(html, mangaUrl);
    } catch (error) {
      console.error("Error fetching chapters:", error);
      throw error;
    }
  }

  /**
   * Numéros des chapitres verrouillés (accès anticipé payant) sur une page série.
   *
   * ⚠️ Le DOM ne le dit PAS : le HTML servi par Asura rend le chapitre verrouillé
   * exactement comme les autres — même `<a>`, même libellé, aucun cadenas. Le
   * badge est ajouté après hydratation par React. Le seul signal disponible côté
   * serveur est le JSON des props de l'îlot Astro qui alimente la liste
   * (`<astro-island props="…">`), où chaque chapitre porte `is_premium` et
   * `early_access_until`. C'est pour ça qu'on parse du JSON ici plutôt qu'un
   * sélecteur : il n'existe pas de sélecteur qui distingue les deux.
   *
   * Les deux champs sont redondants en pratique (Asura passe `is_premium` à
   * `false` quand la fenêtre expire, ~6 h après publication), mais on teste les
   * deux : c'est la lecture prudente, et elle survit si l'un des deux disparaît.
   *
   * @returns l'ensemble des numéros verrouillés, ou `null` si l'îlot est
   *   introuvable/illisible — un `null` veut dire « on ne sait pas », pas
   *   « aucun verrou », et l'appelant doit le signaler.
   */
  private lockedChapterNumbers(html: string): Set<number> | null {
    const $ = cheerio.load(html);
    const locked = new Set<number>();
    const now = Date.now();
    let found = false;

    $("astro-island[props]").each((_, element) => {
      if (found) return;

      let props: unknown;
      try {
        // Cheerio décode déjà les entités de l'attribut (`&quot;` → `"`).
        props = JSON.parse($(element).attr("props") || "");
      } catch {
        return;
      }

      const island = unwrapAstroProps(props);
      if (!isRecord(island) || !Array.isArray(island.chapters)) return;

      found = true;
      for (const entry of island.chapters) {
        if (!isRecord(entry)) continue;

        const number =
          typeof entry.number === "number"
            ? entry.number
            : typeof entry.number === "string"
              ? parseFloat(entry.number)
              : NaN;
        if (!Number.isFinite(number)) continue;

        const until =
          typeof entry.early_access_until === "string"
            ? Date.parse(entry.early_access_until)
            : NaN;

        if (entry.is_premium === true || (Number.isFinite(until) && until > now)) {
          locked.add(number);
        }
      }
    });

    return found ? locked : null;
  }

  /**
   * Parse chapters from manga page HTML
   */
  private parseChapters(html: string, mangaUrl: string): ScrapedChapter[] {
    const $ = cheerio.load(html);
    const chapters: ScrapedChapter[] = [];

    // ⚠️ Volontairement AVANT la boucle : un chapitre en accès anticipé est bien
    // listé sur la page, mais il n'est lisible que par les abonnés. Le remonter
    // ferait annoncer aux utilisateurs un chapitre qu'ils ne peuvent pas ouvrir,
    // et — plus gênant — il resterait ensuite en base comme « déjà vu », donc sa
    // sortie publique quelques heures plus tard ne déclencherait plus rien.
    const locked = this.lockedChapterNumbers(html);
    if (locked === null) {
      // Ni exception ni filtrage : la page reste exploitable, mais on ne sait
      // plus reconnaître les verrous. À traiter comme un changement de markup.
      console.warn(
        `⚠️ Asura: no readable chapter island on ${mangaUrl} — premium chapters can no longer be filtered out`
      );
    } else if (locked.size > 0) {
      console.log(
        `Asura: skipping ${locked.size} premium/early-access chapter(s): ${[...locked].join(", ")}`
      );
    }

    try {
      // Chercher les liens de chapitres dans la structure AsuraScans
      $('.divide-y a[href*="/chapter/"]').each((_, element) => {
        const $el = $(element);
        const href = $el.attr("href");

        if (!href) return;

        // Construire l'URL complète selon le format AsuraScans
        let fullUrl: string;
        if (href.startsWith("http")) {
          fullUrl = href;
        } else if (href.startsWith("/")) {
          fullUrl = `${this.baseUrl}${href}`;
        } else {
          // Chemin relatif (ex: "chapter/90")
          fullUrl = `${mangaUrl}/${href}`;
        }

        // Extraire le numéro de chapitre depuis l'URL
        const chapterMatch = href.match(/\/chapter\/(\d+(?:\.\d+)?)/);

        if (!chapterMatch) return;

        const chapterNumber = parseFloat(chapterMatch[1]);
        if (isNaN(chapterNumber)) return;

        if (locked?.has(chapterNumber)) return;

        // Chercher la date de release avec le sélecteur spécifique
        let releaseDate: string | null = null;
        const dateText = $el
          .find(".text-sm.text-white\\/40")
          .text()
          .trim();

        if (dateText) {
          releaseDate = this.parseToTimestampTz(dateText);
        }

        chapters.push({
          chapter_number: chapterNumber,
          link: fullUrl,
          release_date: releaseDate,
        });
      });

      // Remove duplicates and sort
      const uniqueChapters = chapters.filter(
        (chapter, index, self) =>
          index ===
          self.findIndex((c) => c.chapter_number === chapter.chapter_number)
      );

      uniqueChapters.sort((a, b) => b.chapter_number - a.chapter_number);

      console.log(`Found ${uniqueChapters.length} chapters`);
      return uniqueChapters;
    } catch (error) {
      console.error("Error parsing chapters:", error);
      throw error;
    }
  }

  /**
   * Find the best matching manga from search results
   */
  private findBestMatch(
    searchTitle: string,
    results: AsuraSearchResult[]
  ): AsuraSearchResult | null {
    if (results.length === 0) return null;

    const normalizedSearchTitle = this.cleanTitleForSearch(searchTitle);

    // Définir les mots à ignorer pour le scoring
    const commonWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
      'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'should', 'could', 'may', 'might', 'must', 'can'
    ]);

    // Extraire les mots significatifs du titre de recherche
    const searchWords = normalizedSearchTitle
      .split(" ")
      .filter((w) => w.length > 2 && !commonWords.has(w));

    // 🎯 SINGLE WORD TITLE: Require exact match
    // If the search title is a single word (after normalization), only accept exact matches
    const isSingleWordTitle = searchWords.length === 1;
    if (isSingleWordTitle) {
      const singleWord = searchWords[0];
      console.log(`🎯 Single word title detected: "${singleWord}" - requiring perfect match (title must be ONLY that word)`);
      
      const exactMatch = results.find((result) => {
        const normalizedResultTitle = this.cleanTitleForSearch(result.title);
        const resultWords = normalizedResultTitle.split(" ").filter((w) => w.length > 2 && !commonWords.has(w));
        
        // The result must contain ONLY the single word, no other significant words
        return resultWords.length === 1 && resultWords[0] === singleWord;
      });
      
      if (exactMatch) {
        console.log(`✅ Found perfect match: "${exactMatch.title}"`);
        return exactMatch;
      } else {
        console.log(`❌ No perfect match found for single word title "${singleWord}" (titles with additional words were rejected)`);
        return null;
      }
    }

    // Calculate similarity scores
    const scoredResults = results.map((result) => {
      const normalizedResultTitle = this.cleanTitleForSearch(result.title);
      const resultWords = normalizedResultTitle
        .split(" ")
        .filter((w) => w.length > 2 && !commonWords.has(w));

      // 1. Score de correspondance exacte des mots (très important)
      const exactMatches = searchWords.filter((word) =>
        resultWords.includes(word)
      );
      const exactMatchScore = exactMatches.length / Math.max(searchWords.length, 1);

      // 2. Score de correspondance partielle/similaire des mots
      const similarMatches = searchWords.filter((word) =>
        resultWords.some((rw) => {
          if ((rw.includes(word) && word.length > 3) || (word.includes(rw) && rw.length > 3)) {
            return true;
          }
          const minLen = Math.min(word.length, rw.length);
          if (minLen >= 4) {
            const commonPrefix = this.getCommonPrefix(word, rw);
            if (commonPrefix.length >= 4) return true;
          }
          return false;
        })
      );
      const similarMatchScore = similarMatches.length / Math.max(searchWords.length, 1);

      // 3. Score basé sur les mots uniques et longs (plus discriminants)
      const longWords = searchWords.filter((w) => w.length > 5);
      const longWordMatches = longWords.filter((word) =>
        resultWords.some((rw) => {
          if (rw.includes(word) || word.includes(rw)) return true;
          const commonPrefix = this.getCommonPrefix(word, rw);
          return commonPrefix.length >= Math.min(5, Math.min(word.length, rw.length) - 1);
        })
      );
      const longWordScore = longWords.length > 0 
        ? longWordMatches.length / longWords.length 
        : 0;

      // 4. Bonus pour les mots vraiment uniques/rares (longueur > 7)
      const uniqueWords = searchWords.filter((w) => w.length > 7);
      const uniqueWordMatches = uniqueWords.filter((word) =>
        resultWords.some((rw) => rw.includes(word) || word.includes(rw))
      );
      const uniqueWordScore = uniqueWords.length > 0
        ? uniqueWordMatches.length / uniqueWords.length
        : 0;

      // 5. Score de correspondance totale : combien de mots de la recherche sont trouvés ?
      // Compte exactes + similaires pour avoir le ratio total
      const allMatchedWords = new Set([...exactMatches, ...similarMatches]);
      const totalMatchRatio = allMatchedWords.size / Math.max(searchWords.length, 1);

      // ⚠️ CRITÈRE CRITIQUE : Vérifier que TOUS les mots du titre recherché sont présents
      // Si un mot manque complètement, ce n'est probablement pas le bon manga
      const missingSearchWords = searchWords.filter((word) =>
        !resultWords.some((rw) => {
          // Correspondance exacte
          if (rw === word || word === rw) return true;
          // Inclusion (si le mot est assez long)
          if ((rw.includes(word) && word.length > 3) || (word.includes(rw) && rw.length > 3)) return true;
          // Préfixe commun significatif
          const commonPrefix = this.getCommonPrefix(word, rw);
          return commonPrefix.length >= Math.min(4, Math.min(word.length, rw.length) * 0.7);
        })
      );

      // Si des mots essentiels manquent, appliquer une pénalité SÉVÈRE
      const missingWordsRatio = missingSearchWords.length / Math.max(searchWords.length, 1);
      const missingWordsPenalty = missingWordsRatio > 0 ? missingWordsRatio * 0.8 : 0;

      // 6. Pénalité si le résultat contient trop de mots non pertinents
      const unmatchedResultWords = resultWords.filter((word) =>
        !searchWords.some((sw) => {
          if (sw === word || word.includes(sw) || sw.includes(word)) return true;
          const commonPrefix = this.getCommonPrefix(word, sw);
          return commonPrefix.length >= 4;
        })
      );
      const penaltyScore = unmatchedResultWords.length / Math.max(resultWords.length, 1);

      // PÉNALITÉ SPÉCIALE : Mots supplémentaires LONGS et SIGNIFICATIFS
      // Ex: "Solo Leveling" vs "Solo Leveling: Ragnarok"
      // "Ragnarok" est un mot long (8 lettres) qui n'est PAS dans la recherche
      // → Probablement une série différente (suite, spin-off, etc.)
      const significantExtraWords = unmatchedResultWords.filter((word) => word.length > 6);
      const extraWordsPenalty = significantExtraWords.length > 0 
        ? (significantExtraWords.length / Math.max(resultWords.length, 1)) * 1.2 
        : 0;

      // 7. Bonus pour l'ordre des mots (si les mots apparaissent dans le même ordre)
      let orderBonus = 0;
      let lastFoundIndex = -1;
      let wordsInOrder = 0;
      
      for (const searchWord of searchWords) {
        const foundIndex = resultWords.findIndex((rw) => 
          rw === searchWord || 
          rw.includes(searchWord) || 
          searchWord.includes(rw)
        );
        
        if (foundIndex > lastFoundIndex) {
          wordsInOrder++;
          lastFoundIndex = foundIndex;
        }
      }
      
      if (searchWords.length > 1) {
        orderBonus = wordsInOrder / searchWords.length;
      }

      // Score combiné avec pondération améliorée
      const combinedScore = 
        exactMatchScore * 0.30 +        // Correspondance exacte (très important)
        totalMatchRatio * 0.25 +        // Ratio total de mots matchés
        longWordScore * 0.15 +          // Mots longs (discriminants)
        similarMatchScore * 0.10 +      // Correspondance similaire
        uniqueWordScore * 0.10 +        // Mots uniques
        orderBonus * 0.10 -             // Bonus ordre des mots
        (penaltyScore * 0.15) -         // Pénalité pour mots non pertinents
        (missingWordsPenalty * 0.60) -  // 🔥 PÉNALITÉ MAJEURE pour mots manquants
        (extraWordsPenalty * 0.50);     // 🚫 PÉNALITÉ pour mots supplémentaires significatifs

      return {
        ...result,
        score: combinedScore,
        debug: {
          exactMatches: exactMatches.join(', '),
          similarMatches: similarMatches.join(', '),
          unmatchedWords: unmatchedResultWords.join(', '),
          missingWords: missingSearchWords.join(', '),
          significantExtraWords: significantExtraWords.join(', '),
          exactMatchScore,
          similarMatchScore,
          longWordScore,
          uniqueWordScore,
          totalMatchRatio,
          penaltyScore,
          missingWordsPenalty,
          extraWordsPenalty,
          orderBonus,
        }
      };
    });

    // Sort by score (highest first)
    scoredResults.sort((a, b) => b.score - a.score);

    // Afficher les 3 meilleurs résultats pour debug
    console.log('\n=== Search Results ===');
    console.log(`Search: "${searchTitle}"`);
    console.log(`Normalized: "${normalizedSearchTitle}"`);
    console.log(`Keywords: [${searchWords.join(', ')}]\n`);
    
    scoredResults.slice(0, 3).forEach((result, index) => {
      console.log(`${index + 1}. "${result.title}" - Score: ${result.score.toFixed(3)}`);
      console.log(`   Exact: [${result.debug.exactMatches || 'none'}]`);
      console.log(`   Similar: [${result.debug.similarMatches || 'none'}]`);
      console.log(`   ⚠️ Missing: [${result.debug.missingWords || 'none'}]`);
      console.log(`   🚫 Extra (>6 chars): [${result.debug.significantExtraWords || 'none'}]`);
      console.log(`   Unmatched: [${result.debug.unmatchedWords || 'none'}]`);
      console.log(`   Scores: exact=${result.debug.exactMatchScore.toFixed(2)}, total=${result.debug.totalMatchRatio.toFixed(2)}, missing=${result.debug.missingWordsPenalty.toFixed(2)}, extra=${result.debug.extraWordsPenalty.toFixed(2)}, long=${result.debug.longWordScore.toFixed(2)}, order=${result.debug.orderBonus.toFixed(2)}`);
    });
    console.log('==================\n');

    // Si le score est trop faible, c'est probablement un mauvais match
    const MIN_CONFIDENCE_SCORE = 0.3;
    
    if (scoredResults[0].score < MIN_CONFIDENCE_SCORE) {
      console.warn(`⚠️  Best match score too low: ${scoredResults[0].score.toFixed(3)} < ${MIN_CONFIDENCE_SCORE}`);
      console.warn(`   Rejecting "${scoredResults[0].title}" - likely not a match`);
      return null;
    }

    // 🚫 REJET STRICT : Si des mots supplémentaires significatifs sont détectés
    // Ex: "Solo Leveling" vs "Solo Leveling: Ragnarok"
    // → "Ragnarok" est un mot supplémentaire long → probablement une autre série
    const bestMatch = scoredResults[0];
    
    // Récupérer le nombre de mots originaux pour la comparaison
    const originalSearchWordCount = normalizedSearchTitle.split(" ").filter((w) => w.length > 0).length;
    
    if (bestMatch.debug.significantExtraWords && 
        bestMatch.debug.significantExtraWords.length > 0 &&
        originalSearchWordCount <= 2) {  // Seulement pour les titres courts (≤3 mots au total)
      console.warn(`🚫 REJECTED: "${bestMatch.title}"`);
      console.warn(`   Reason: Contains significant extra words not in search query`);
      console.warn(`   Search: "${searchTitle}" (${originalSearchWordCount} words)`);
      console.warn(`   Significant keywords found: [${searchWords.join(', ')}] (${searchWords.length} significant)`);
      console.warn(`   Extra: [${bestMatch.debug.significantExtraWords}]`);
      console.warn(`   This likely indicates a different series (sequel, spin-off, etc.)`);
      return null;
    }

    // Avertissement si le score est entre 0.30 et 0.50
    if (scoredResults[0].score < 0.50) {
      console.warn(`⚠️  Low confidence match (score: ${scoredResults[0].score.toFixed(3)}). Manual verification recommended.`);
    }

    return scoredResults[0];
  }

  /**
   * Récupère les mots les plus significatifs d'un titre pour la recherche
   * Retourne les 2-3 mots les plus longs et significatifs
   * Ignore les mots courants comme "the", "a", "an", etc.
   * Enlève les apostrophes et le contenu après (ex: "swordmaster's" -> "swordmaster")
   */
  private getLongestWord(title: string): string {
    // Mots à ignorer (articles, prépositions courantes, etc.)
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
      'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did'
    ]);

    // Extraire les mots et nettoyer
    const words = title
      .toLowerCase()
      .replace(/[^\w\s']/g, ' ') // Remplacer les caractères spéciaux par des espaces
      .split(/\s+/)
      .map(word => {
        // Enlever l'apostrophe et tout ce qui suit (ex: "swordmaster's" -> "swordmaster")
        const apostropheIndex = word.indexOf("'");
        if (apostropheIndex > 0) {
          return word.substring(0, apostropheIndex);
        }
        return word;
      })
      .filter(word => word.length > 3 && !stopWords.has(word)); // Minimum 4 caractères

    if (words.length === 0) return title.trim();

    // Trier les mots par longueur (décroissant) et prendre les 2-3 premiers
    const sortedWords = [...words].sort((a, b) => b.length - a.length);
    
    // Prendre jusqu'à 3 mots les plus longs, ou tous si moins de 3
    const topWords = sortedWords.slice(0, Math.min(3, sortedWords.length));
    
    // Retourner les mots séparés par des espaces
    return topWords.join(' ');
  }

  /**
   * Clean title for comparison
   * Normalise les titres pour la comparaison en enlevant les apostrophes et le contenu après
   */
  private cleanTitleForSearch(title: string): string {
    return (
      title
        .toLowerCase()
        // Remplacer les différents types d'apostrophes par une apostrophe standard
        .replace(/[''`]/g, "'")
        // Supprimer l'apostrophe et tout ce qui suit jusqu'à l'espace suivant
        // "swordmaster's son" -> "swordmaster son", "academy's" -> "academy"
        .replace(/'\w*/g, "")
        // Remplacer les tirets et underscores par des espaces
        .replace(/[-_]/g, " ")
        // Supprimer les articles "the" au début
        .replace(/^the\s+/i, "")
        // Supprimer les caractères spéciaux
        .replace(/[^\w\s]/g, "")
        // Normaliser les espaces multiples
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  /**
   * Get the common prefix between two strings
   * Returns the longest common prefix
   */
  private getCommonPrefix(str1: string, str2: string): string {
    let i = 0;
    const minLength = Math.min(str1.length, str2.length);
    
    while (i < minLength && str1[i] === str2[i]) {
      i++;
    }
    
    return str1.substring(0, i);
  }

  /**
   * Calculate similarity between two strings
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Convertit une date textuelle anglaise (ex: "September 4th 2024")
   * en format timestamptz ISO compatible Supabase
   */
  private parseToTimestampTz(dateString: string): string | null {
    // Supprimer les suffixes anglais comme "st", "nd", "rd", "th"
    const cleanDate = dateString.replace(/(\d+)(st|nd|rd|th)/, "$1");

    // Créer un objet Date
    const date = new Date(cleanDate);

    if (isNaN(date.getTime())) {
      console.warn("Invalid date format:", dateString);
      return null;
    }

    // Retourner la date au format ISO avec fuseau horaire (timestamptz)
    return date.toISOString(); // ex: "2024-09-04T00:00:00.000Z"
  }

  /**
   * Parse date string to ISO format
   */
  private parseDate(dateStr: string): string | null {
    try {
      if (!dateStr || dateStr.trim() === "") return null;

      const trimmed = dateStr.trim().toLowerCase();

      // Handle relative dates
      if (trimmed.includes("ago")) {
        return this.parseRelativeDate(trimmed);
      }

      // Handle "today", "yesterday"
      if (trimmed === "today") {
        return new Date().toISOString();
      }

      if (trimmed === "yesterday") {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return yesterday.toISOString();
      }

      // Try to parse as regular date
      const date = new Date(dateStr);
      return isNaN(date.getTime()) ? null : date.toISOString();
    } catch (error) {
      console.error("Error parsing date:", dateStr, error);
      return null;
    }
  }

  /**
   * Parse relative date strings like "2 days ago"
   */
  private parseRelativeDate(dateStr: string): string | null {
    const now = new Date();

    const dayMatch = dateStr.match(/(\d+)\s*days?\s*ago/);
    if (dayMatch) {
      const days = parseInt(dayMatch[1]);
      now.setDate(now.getDate() - days);
      return now.toISOString();
    }

    const weekMatch = dateStr.match(/(\d+)\s*weeks?\s*ago/);
    if (weekMatch) {
      const weeks = parseInt(weekMatch[1]);
      now.setDate(now.getDate() - weeks * 7);
      return now.toISOString();
    }

    const monthMatch = dateStr.match(/(\d+)\s*months?\s*ago/);
    if (monthMatch) {
      const months = parseInt(monthMatch[1]);
      now.setMonth(now.getMonth() - months);
      return now.toISOString();
    }

    const hourMatch = dateStr.match(/(\d+)\s*hours?\s*ago/);
    if (hourMatch) {
      const hours = parseInt(hourMatch[1]);
      now.setHours(now.getHours() - hours);
      return now.toISOString();
    }

    return null;
  }
}

export const asuraComicScraper = new AsuraComicScraper();

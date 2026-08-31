import { ScrapedChapter } from "../types";
import { scraperSignal } from "../lib/http";
import { MangaScraper } from "./types";
import { load } from "cheerio";

/**
 * Scraper GÉNÉRIQUE pour les sites de scan sous WordPress.
 *
 * 🎯 Pourquoi un scraper paramétré plutôt qu'un fichier par site : la longue
 * traîne des manhwa n'est traduite que par de petits groupes qui montent chacun
 * leur WordPress, avec deux ou trois thèmes qui reviennent partout. Un fichier
 * par site, ce serait la même logique recopiée N fois — et N endroits à corriger
 * quand un thème bouge. Ici un site = une entrée de config (cf. les instances en
 * bas de fichier), et le code est commun.
 *
 * ⚠️ Ce n'est PAS un scraper « Madara ». Ces sites partagent `wp-content` et
 * `admin-ajax.php` parce qu'ils sont sous WordPress, rien de plus : Rokari est
 * sous le thème Themesia (`.eph-num`/`.chapternum`), et l'endpoint Madara
 * `action=manga_get_chapters` y répond 400. D'autres publient leurs chapitres
 * en JSON-LD sans une seule classe commune. D'où l'extraction en stratégies
 * successives (`extractChapters`) plutôt qu'un markup unique : c'est ce qui
 * permet d'ajouter le site suivant sans toucher au code.
 *
 * 📌 Les exemples chiffrés des commentaires ci-dessous viennent de sites
 * réellement inspectés (dont Rinko Comics, évalué puis écarté). Ce sont des
 * observations de terrain, pas des sites configurés ici.
 */

/** UA de navigateur : ces WordPress répondent 403 à un UA vide ou exotique. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Nombre de titres testés dans la recherche avant d'abandonner.
 *
 * Une série porte souvent 5-6 titres alternatifs (Aching / Heart-Aching /
 * Lingering Pain / 아리도록…). Les essayer tous coûterait autant de requêtes sur
 * CHAQUE série absente du site — soit le cas le plus fréquent. On s'arrête à 3.
 */
const MAX_SEARCH_QUERIES = 3;

/** Seuil de similarité quand aucun titre ne correspond exactement. */
const SIMILARITY_THRESHOLD = 0.7;

/** Description d'un site à scraper. */
export interface WpComicSite {
  /**
   * ⚠️ Doit être IDENTIQUE au `name` du `ScraperConfig` enregistré dans
   * `scraperManager` : c'est ce nom que le manager renvoie dans ses résultats,
   * et `getScraperConfig` le retrouve via `name.toLowerCase()` sans espaces.
   */
  name: string;
  /** Racine du site, sans slash final. */
  baseUrl: string;
  /**
   * Type de post exposé par l'API REST de WordPress, quand le site la laisse
   * ouverte (`/wp-json/wp/v2/<type>?search=…`). À PRIVILÉGIER : c'est une vraie
   * recherche côté serveur, elle renvoie du JSON stable, et elle évite de
   * télécharger une page de résultats de 360 Ko.
   *
   * ⚠️ Tous les sites ne l'exposent pas — Rokari répond `rest_no_route` sur
   * tous les types testés (`manga`, `wp-manga`, `comic`, `series`). D'où le
   * repli HTML ci-dessous, qui reste le chemin par défaut.
   *
   * Aucun site configuré ne l'utilise aujourd'hui. On garde le chemin : il a
   * été validé en conditions réelles, et c'est précisément ce qui permettra
   * d'ajouter le prochain WordPress sans réécrire de code.
   */
  restPostType?: string;
  /** Chemin de la recherche HTML, `{q}` remplacé par la requête encodée. */
  searchPath: string;
  /**
   * Préfixes d'URL identifiant une page SÉRIE (et non un chapitre ou une page
   * de contenu). Rokari sert `/manga/`, d'autres thèmes `/comic/`.
   */
  seriesPathPrefixes: string[];
}

interface SeriesCandidate {
  /** Titre affiché par le site. */
  title: string;
  /** Slug de l'URL, souvent plus proche du titre original que le titre affiché. */
  slug: string;
  url: string;
}

export class WpComicScraper implements MangaScraper {
  constructor(private readonly site: WpComicSite) {}

  /**
   * @see MangaScraper.scrapeChapters — contrat d'erreur : `[]` = « pas ici »,
   * toute panne (réseau, HTTP, parsing) remonte en exception.
   */
  async scrapeChapters(
    mangaTitle: string,
    malId?: number,
    titleSynonyms?: string[],
    titleEnglish?: string
  ): Promise<ScrapedChapter[]> {
    const variants = this.titleVariants(mangaTitle, titleSynonyms, titleEnglish);
    console.log(
      `Scraping ${this.site.name} for: ${mangaTitle} (${variants.length} title variant(s))`
    );

    let match: SeriesCandidate | null = null;
    for (const query of variants.slice(0, MAX_SEARCH_QUERIES)) {
      const candidates = await this.search(query);
      match = this.findBestMatch(variants, candidates);
      if (match) break;
    }

    if (!match) {
      console.log(`No match for "${mangaTitle}" on ${this.site.name}`);
      return [];
    }

    console.log(`Match: "${match.title}" → ${match.url}`);
    const chapters = this.extractChapters(await this.fetchHtml(match.url));

    if (chapters.length === 0) {
      // ⚠️ On rend `[]`, PAS une exception — cf. la « limite connue » du contrat
      // d'erreur : une série trouvée mais sans chapitre publié est légitime, et
      // lever ici ferait passer ce cas normal pour une panne. Le warning est là
      // pour que la colonne `Empty` du bilan de run soit lisible : un site qui
      // matche ses séries et n'en tire jamais un chapitre a changé de markup.
      console.warn(
        `⚠️ ${this.site.name}: matched "${match.title}" but extracted 0 chapters — selectors may be stale`
      );
    } else {
      console.log(`Found ${chapters.length} chapters on ${this.site.name}`);
    }

    return chapters;
  }

  /** Titres à essayer, dédupliqués, titre principal en tête. */
  private titleVariants(
    mangaTitle: string,
    titleSynonyms?: string[],
    titleEnglish?: string
  ): string[] {
    const all = [mangaTitle, titleEnglish, ...(titleSynonyms || [])];
    const seen = new Set<string>();
    const variants: string[] = [];

    for (const title of all) {
      if (!title) continue;
      const key = this.normalize(title);
      // Un titre non latin (coréen, japonais…) ne donne rien sur ces sites, qui
      // n'indexent que le titre anglais : on ne gaspille pas une des 3 requêtes.
      if (!key || seen.has(key) || !/[a-z]/.test(key)) continue;
      seen.add(key);
      variants.push(title);
    }

    return variants;
  }

  /**
   * Récupère les séries proposées par le site pour une requête.
   *
   * ⚠️ Quand l'API REST est disponible, elle fait AUTORITÉ — y compris quand
   * elle ne renvoie rien. Retomber sur le HTML « au cas où » coûterait une
   * seconde requête sur chaque série absente, c'est-à-dire le cas le plus
   * fréquent, et pour un résultat moins fiable : la recherche HTML de ces
   * thèmes ne filtre parfois rien du tout (cf. `findBestMatch`).
   */
  private async search(query: string): Promise<SeriesCandidate[]> {
    if (this.site.restPostType) {
      return this.searchViaRest(query);
    }
    return this.searchViaHtml(query);
  }

  /** Recherche via l'API REST de WordPress. */
  private async searchViaRest(query: string): Promise<SeriesCandidate[]> {
    const url =
      `${this.site.baseUrl}/wp-json/wp/v2/${this.site.restPostType}` +
      `?search=${encodeURIComponent(query)}&per_page=10&_fields=link,slug,title`;

    const response = await fetch(url, {
      signal: scraperSignal(),
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`${this.site.name}: HTTP ${response.status} on ${url}`);
    }

    const payload = (await response.json()) as Array<{
      link?: string;
      slug?: string;
      title?: { rendered?: string };
    }>;

    const candidates = (Array.isArray(payload) ? payload : [])
      .filter((post) => post.link && post.slug)
      .map((post) => ({
        // `title.rendered` contient des entités HTML (’ → &#8217;) : on les
        // décode, sinon la normalisation compare des chaînes différentes.
        title: this.decodeEntities(post.title?.rendered || "") || post.slug!,
        slug: post.slug!,
        url: post.link!,
      }));

    console.log(
      `  ${this.site.name}: "${query}" → ${candidates.length} series candidate(s) (REST)`
    );
    return candidates;
  }

  /** Recherche via la page de résultats HTML du thème. */
  private async searchViaHtml(query: string): Promise<SeriesCandidate[]> {
    const url =
      this.site.baseUrl +
      this.site.searchPath.replace("{q}", encodeURIComponent(query));

    const $ = load(await this.fetchHtml(url));
    const candidates = new Map<string, SeriesCandidate>();

    $("a[href]").each((_, element) => {
      const $el = $(element);
      const href = $el.attr("href");
      if (!href) return;

      const absolute = href.startsWith("http")
        ? href
        : `${this.site.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
      if (!absolute.startsWith(this.site.baseUrl)) return;

      const path = absolute.slice(this.site.baseUrl.length);
      const prefix = this.site.seriesPathPrefixes.find((p) =>
        path.startsWith(p)
      );
      if (!prefix) return;

      const slug = path.slice(prefix.length).replace(/\/.*$/, "");
      // Un slug vide = le lien vers l'index des séries, pas une série.
      if (!slug) return;

      // Le titre vit tantôt dans `title`, tantôt dans l'`alt` de la vignette,
      // tantôt dans le texte du lien — selon le thème. Le slug sert de filet.
      const title =
        $el.attr("title")?.trim() ||
        $el.find("img").attr("alt")?.trim() ||
        $el.text().replace(/\s+/g, " ").trim() ||
        slug.replace(/-/g, " ");

      if (!candidates.has(slug)) {
        candidates.set(slug, { title, slug, url: `${this.site.baseUrl}${prefix}${slug}/` });
      }
    });

    console.log(
      `  ${this.site.name}: "${query}" → ${candidates.size} series candidate(s) (HTML)`
    );
    return [...candidates.values()];
  }

  /**
   * Choisit la série correspondante.
   *
   * ⚠️ Le seuil est volontairement plus sévère que celui des autres scrapers
   * (0.7 contre 0.4) : la recherche de certains de ces thèmes ne filtre RIEN
   * côté serveur et renvoie le catalogue entier — un thème mesuré rendait les
   * mêmes 39 séries pour n'importe quelle requête. Avec un seuil bas, la
   * première série venue passerait pour un match et on écrirait les chapitres
   * d'une AUTRE série.
   */
  private findBestMatch(
    variants: string[],
    candidates: SeriesCandidate[]
  ): SeriesCandidate | null {
    if (candidates.length === 0) return null;

    const wanted = variants.map((title) => this.normalize(title));

    // 1. Égalité exacte après normalisation. C'est le cas courant : les titres
    //    alternatifs viennent de MAL et sont souvent EXACTEMENT ceux du site
    //    ("Heart Aching" ↔ "Heart-Aching", "Lingering Pain" ↔ "Lingering Pain").
    for (const candidate of candidates) {
      const forms = [
        this.normalize(candidate.title),
        this.normalize(candidate.slug.replace(/-/g, " ")),
      ];
      if (forms.some((form) => form && wanted.includes(form))) {
        return candidate;
      }
    }

    // 2. Sinon, meilleure similarité au-dessus du seuil.
    let best: SeriesCandidate | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      for (const form of [candidate.title, candidate.slug.replace(/-/g, " ")]) {
        for (const title of variants) {
          const score = this.similarity(title, form);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }
    }

    if (!best || bestScore < SIMILARITY_THRESHOLD) {
      if (best) {
        console.log(
          `  Best candidate "${best.title}" scored ${bestScore.toFixed(2)} < ${SIMILARITY_THRESHOLD} — rejected`
        );
      }
      return null;
    }

    console.log(`  Matched by similarity ${bestScore.toFixed(2)}`);
    return best;
  }

  /**
   * Extrait les chapitres d'une page série, par stratégies successives.
   *
   * L'ordre n'est pas arbitraire : le JSON-LD passe en premier parce qu'il est
   * à la fois le plus stable (données structurées, pas de classes CSS) et le
   * plus complet : sur un des thèmes mesurés, le DOM ne rendait que les 8
   * derniers chapitres là où le JSON-LD les listait tous les 24, dates ISO
   * comprises.
   */
  private extractChapters(html: string): ScrapedChapter[] {
    const $ = load(html);
    const chapters = new Map<number, ScrapedChapter>();

    const add = (
      link: string | undefined,
      rawNumber: string | number | undefined,
      rawDate: string | undefined
    ): void => {
      if (!link) return;
      const chapter_number = this.parseChapterNumber(rawNumber, link);
      if (chapter_number === null || chapters.has(chapter_number)) return;
      chapters.set(chapter_number, {
        chapter_number,
        link: link.startsWith("http") ? link : `${this.site.baseUrl}${link}`,
        release_date: this.parseDate(rawDate),
      });
    };

    // Stratégie 1 — JSON-LD schema.org.
    for (const node of this.jsonLdNodes($)) {
      if (node["@type"] !== "Chapter") continue;
      add(
        typeof node.url === "string" ? node.url : undefined,
        typeof node.position === "string" || typeof node.position === "number"
          ? node.position
          : typeof node.name === "string"
            ? node.name
            : undefined,
        typeof node.datePublished === "string" ? node.datePublished : undefined
      );
    }

    // Stratégie 2 — thème Themesia (Rokari et la plupart des forks d'Asura).
    $("#chapterlist li, .eph-num").each((_, element) => {
      const $el = $(element);
      const $link = $el.is("a") ? $el : $el.find("a[href]").first();
      add(
        $link.attr("href"),
        $el.attr("data-num") ||
          $el.closest("li").attr("data-num") ||
          $el.find(".chapternum").text().replace(/\s+/g, " ").trim(),
        $el.find(".chapterdate").text().trim()
      );
    });

    // Stratégie 3 — filet générique : n'importe quel lien qui ressemble à un
    // chapitre de ce site. Sans date, mais mieux que rien si le thème change.
    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      if (!href || !/chapter[-_/]?\d/i.test(href)) return;
      if (!href.startsWith("/") && !href.startsWith(this.site.baseUrl)) return;
      add(href, undefined, undefined);
    });

    return [...chapters.values()].sort(
      (a, b) => b.chapter_number - a.chapter_number
    );
  }

  /** Tous les objets contenus dans les blocs `application/ld+json` de la page. */
  private jsonLdNodes($: ReturnType<typeof load>): Record<string, unknown>[] {
    const nodes: Record<string, unknown>[] = [];

    $('script[type="application/ld+json"]').each((_, element) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse($(element).text());
      } catch {
        // Un bloc JSON-LD malformé est fréquent et sans conséquence : les autres
        // stratégies prennent le relais. On ne fait pas échouer le scrape.
        return;
      }

      // Le JSON-LD est tantôt un objet, tantôt un tableau, tantôt un @graph, et
      // les chapitres sont imbriqués (`hasPart`, `itemListElement`…) : on aplatit.
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        nodes.push(record);
        Object.values(record).forEach(walk);
      };

      walk(parsed);
    });

    return nodes;
  }

  /**
   * Numéro de chapitre, depuis une valeur explicite (`data-num`, `position`,
   * « Chapter 24 ») ou, à défaut, depuis l'URL.
   */
  private parseChapterNumber(
    raw: string | number | undefined,
    link: string
  ): number | null {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;

    if (typeof raw === "string") {
      // « Chapter 24 », « Ch. 24.5 », ou juste « 24 ».
      const match = raw.match(/(\d+(?:\.\d+)?)/);
      if (match) return parseFloat(match[1]);
    }

    // `…/heart-aching-chapter-24/` → 24, `…-chapter-24-5/` → 24.5.
    // On ancre sur « chapter » : un slug peut contenir d'autres nombres
    // (« 28-youth »), et c'est le DERNIER segment qui porte le numéro.
    const fromUrl = link.match(/chapter[-_/]?(\d+)(?:[-.](\d+))?/i);
    if (fromUrl) {
      return parseFloat(fromUrl[2] ? `${fromUrl[1]}.${fromUrl[2]}` : fromUrl[1]);
    }

    return null;
  }

  /**
   * Date de sortie en ISO, ou `null`.
   *
   * Deux formats à couvrir : l'ISO du JSON-LD, et le texte des thèmes HTML
   * (« August 29, 2026 », mais aussi « 2 days ago » sur les chapitres récents —
   * précisément ceux dont la date compte, puisqu'elle pilote le tier de
   * rafraîchissement de la série).
   */
  private parseDate(raw: string | undefined): string | null {
    if (!raw) return null;
    const text = raw.trim();
    if (!text) return null;

    const relative = text.match(
      /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i
    );
    if (relative) {
      const value = parseInt(relative[1], 10);
      const unitMs: Record<string, number> = {
        second: 1_000,
        minute: 60_000,
        hour: 3_600_000,
        day: 86_400_000,
        week: 604_800_000,
        month: 2_592_000_000, // 30 j — approximation assumée
        year: 31_536_000_000, // 365 j
      };
      return new Date(
        Date.now() - value * unitMs[relative[2].toLowerCase()]
      ).toISOString();
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  /** GET borné par le budget commun. Toute réponse non-OK est une panne. */
  private async fetchHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      signal: scraperSignal(),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      throw new Error(
        `${this.site.name}: HTTP ${response.status} on ${url}`
      );
    }

    const html = await response.text();

    // ⚠️ Cloudflare rend son interstitiel en 200. Sans ce garde-fou on
    // extrairait 0 chapitre et le run compterait un `Empty` — un blocage
    // déguisé en « série absente ». C'est une panne : on lève.
    if (/<title>\s*Just a moment/i.test(html) || html.includes("cf-browser-verification")) {
      throw new Error(
        `${this.site.name}: Cloudflare challenge on ${url} (needs got-scraping, cf. weebCentralScraper)`
      );
    }

    return html;
  }

  /** Décode les entités HTML d'un titre (`&#8217;` → `’`). */
  private decodeEntities(text: string): string {
    return load(`<span>${text}</span>`)("span").text().trim();
  }

  /** Minuscules, sans ponctuation ni espaces multiples — pour comparer. */
  private normalize(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Similarité de Jaccard sur les mots, comme les autres scrapers du dépôt. */
  private similarity(a: string, b: string): number {
    const wordsA = new Set(this.normalize(a).split(" ").filter(Boolean));
    const wordsB = new Set(this.normalize(b).split(" ").filter(Boolean));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    const intersection = [...wordsA].filter((word) => wordsB.has(word));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.length / union.size;
  }
}

/**
 * Sites configurés.
 *
 * Pour en ajouter un : une entrée ici + l'enregistrement dans `scraperManager`
 * (le `name` doit être identique des deux côtés) + l'export dans `index.ts`.
 * Aucun code à écrire tant que le site retombe sur une des trois stratégies.
 */
export const rokariComicsScraper = new WpComicScraper({
  name: "Rokari Comics",
  baseUrl: "https://rokaricomics.com",
  searchPath: "/?s={q}&post_type=wp-manga",
  seriesPathPrefixes: ["/manga/"],
});

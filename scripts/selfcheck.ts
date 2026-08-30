#!/usr/bin/env node
/**
 * Vérification de la logique du cron, SANS réseau ni base de données.
 *
 * ⚠️ Raison d'être : tout ce qui compte ici est un choix qu'on ne peut pas relire
 * dans un log de production — « cette source est-elle vraiment coupée ? », « cette
 * attente est-elle comptée comme du scraping ? », « une série absente partout est-elle
 * un échec ? ». Chacune de ces réponses a déjà été fausse en production. Elles sont
 * donc figées ici, avec le pourquoi dans le libellé du test.
 *
 * Les scrapers sont remplacés par des doublures : aucun appel sortant, aucune écriture.
 *
 *   npm run selfcheck
 */

// Les clients Supabase se construisent à l'import et exigent ces variables. Les
// valeurs sont bidon : aucune requête n'est émise (les scrapers sont doublés et la
// synchro DB est court-circuitée).
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://selfcheck.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "selfcheck";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "selfcheck";

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name} ${extra === undefined ? "" : JSON.stringify(extra)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // Imports dynamiques : ils doivent s'exécuter APRÈS les variables ci-dessus.
  const { buildProviderAlerts, buildRunSummary } = await import("../src/lib/runSummary");
  const { Semaphore } = await import("../src/lib/semaphore");
  const { DEFAULT_TIERS, parseTiers, tierFor } = await import("../src/lib/refreshTiers");
  const { selectChaptersToUpsert } = await import("../src/lib/chapterDelta");
  const { ScraperManager } = await import("../src/scrapers/scraperManager");
  type ScraperConfig = import("../src/scrapers/types").ScraperConfig;
  type ScrapedChapter = import("../src/types").ScrapedChapter;

  const chapter = (n: number) =>
    ({ chapter_number: n, link: `l${n}`, release_date: null }) as ScrapedChapter;

  /** Manager câblé sur de faux scrapers : aucune requête réseau, aucune base. */
  function fakeManager(behaviour: (name: string) => Promise<ScrapedChapter[]>) {
    const manager = new ScraperManager();
    // Court-circuite la synchro DB : `getEnabledScrapers` n'ira pas interroger Supabase.
    (manager as unknown as { initialized: boolean }).initialized = true;
    const calls: string[] = [];
    const scrapers = (manager as unknown as { scrapers: Map<string, unknown> }).scrapers;
    const configs = (manager as unknown as { configs: Map<string, ScraperConfig> }).configs;
    for (const key of [...scrapers.keys()]) {
      const name = configs.get(key)!.name;
      scrapers.set(key, {
        scrapeChapters: async () => {
          calls.push(name);
          return behaviour(name);
        },
      });
    }
    return { manager, calls };
  }

  console.log("\n— Alertes : strictes par construction, sinon elles finissent coupées");
  const P = (provider: string, attempts: number, empty: number, errors: number) => ({
    provider, attempts, withChapters: attempts - empty - errors, empty, errors,
    chapters: 0, medianMs: 1, p95Ms: 1, maxMs: 1,
  });
  check("échantillon < 50 tentatives : pas d'alerte", buildProviderAlerts([P("A", 49, 0, 49)]).length === 0);
  check("81 % d'erreurs sur 100 : alerte", buildProviderAlerts([P("A", 100, 0, 81)]).length === 1);
  check("80 % pile : pas d'alerte (seuil strict)", buildProviderAlerts([P("A", 100, 0, 80)]).length === 0);
  check("99 % de vides : alerte panne SILENCIEUSE", /silent breakage/.test(buildProviderAlerts([P("A", 100, 99, 0)])[0] ?? ""));
  check("source saine : rien", buildProviderAlerts([P("A", 500, 100, 0)]).length === 0);

  console.log("\n— Bilan de run");
  const baseSummary = {
    seriesWithChapters: 2000, needingUpdate: 900, processed: 700, skippedForDeadline: 200,
    succeeded: 690, chaptersWritten: 12, totalMs: 600_000, concurrency: 8, batchDelayMs: 300,
    updateIntervalHours: 2, providers: [P("Weeb Central", 700, 695, 0)],
    trippedProviders: ["MangaPark"],
  };
  const withQueue = buildRunSummary({
    ...baseSummary, processed: 900, succeeded: 900,
    mangaDurations: Array(900).fill(5000),
    mangaBusyDurations: Array(900).fill(3000),
    mangaWaitDurations: Array(900).fill(2000),
    sourceConcurrency: 4,
    tierBreakdown: [{ label: "active", intervalHours: 2, candidates: 300 }],
  }).join("\n");
  // 900 × 3 s de scrape utile sur 600 s × 8 workers = 56 %. L'attente (38 %) est à part.
  check("occupation calculée sur le temps UTILE (56 %)", /spent scraping \| 56%/.test(withQueue), withQueue.match(/spent scraping.*/)?.[0]);
  check("🔴 l'attente en file ne gonfle pas l'occupation (38 % à part)", /queued on source limits \| 38%/.test(withQueue));
  check("paliers affichés", /\| active \| 2h \| 300 \|/.test(withQueue));
  check("étiquette de cadence par palier", /Needing update \(per-tier cadence/.test(withQueue));

  const uniform = buildRunSummary({
    ...baseSummary, mangaDurations: [100, 200, 300], mangaBusyDurations: [100, 200, 300],
    mangaWaitDurations: [0, 0, 0], sourceConcurrency: 0, tierBreakdown: [],
  }).join("\n");
  check("séries traitées + reliquat de la deadline", /Processed this run \| 700 \(200 left/.test(uniform));
  check("succès rapportés au TRAITÉ, pas au candidat", /Updated successfully \| 690 \/ 700/.test(uniform));
  check("alerte en tête du bilan", /🔴 \*\*Alerts\*\*/.test(uniform));
  check("coupe-circuit nommé", /Circuit breaker opened.*MangaPark/.test(uniform));
  check("sans limite par source : pas de ligne d'attente", !/queued on source limits/.test(uniform));
  check("sans paliers : ancienne étiquette « >2h »", /Needing update \(>2h/.test(uniform));

  console.log("\n— Sémaphore : la limite par source");
  {
    const semaphore = new Semaphore(2);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 10 }, () => semaphore.run(async () => {
      active++; peak = Math.max(peak, active); await sleep(10); active--;
    })));
    check("jamais plus que la limite en vol", peak === 2, { peak });
    check("tous les jetons rendus", semaphore.pending === 0);
  }
  {
    const semaphore = new Semaphore(1);
    await semaphore.run(async () => { throw new Error("boom"); }).catch(() => {});
    let reused = false;
    await semaphore.run(async () => { reused = true; });
    check("🔴 une exception rend quand même le jeton (sinon le run se fige)", reused);
  }
  {
    const semaphore = new Semaphore(1);
    const waits: number[] = [];
    await Promise.all([
      semaphore.run(async (waited) => { waits.push(waited); await sleep(40); }),
      semaphore.run(async (waited) => { waits.push(waited); }),
    ]);
    check("l'attente du 2e est mesurée", waits[0] < 20 && waits[1] >= 30, { waits });
  }

  console.log("\n— Paliers de cadence");
  {
    const now = Date.parse("2026-08-30T00:00:00Z");
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    check("chapitre d'hier : palier actif (2 h)", tierFor(ago(1), DEFAULT_TIERS, now).intervalHours === 2);
    check("7 jours pile : encore actif", tierFor(ago(7), DEFAULT_TIERS, now).intervalHours === 2);
    check("15 jours : palier lent (6 h)", tierFor(ago(15), DEFAULT_TIERS, now).intervalHours === 6);
    check("2 ans : dormant, PLAFONNÉ à 24 h", tierFor(ago(730), DEFAULT_TIERS, now).intervalHours === 24);
    check("🔴 date inconnue : palier le plus FRÉQUENT (RPC pas encore déployée)", tierFor(null, DEFAULT_TIERS, now).intervalHours === 2);
    check("date illisible : on ne ralentit pas sur une donnée incomprise", tierFor("pas-une-date", DEFAULT_TIERS, now).intervalHours === 2);
    check("date future : palier le plus fréquent", tierFor(ago(-5), DEFAULT_TIERS, now).intervalHours === 2);
    check("CRON_TIERS valide", JSON.stringify(parseTiers("3:1,10:4,*:12")?.map((t) => t.intervalHours)) === "[1,4,12]");
    check("CRON_TIERS sans fourre-tout : refusé", parseTiers("3:1,10:4") === null);
    check("CRON_TIERS fourre-tout mal placé : refusé", parseTiers("*:12,3:1") === null);
    check("CRON_TIERS illisible : refusé (on garde les défauts)", parseTiers("banane") === null);
  }

  console.log("\n— Écriture en delta");
  {
    const scraped = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(chapter);
    let r = selectChaptersToUpsert(scraped, new Set(), 5);
    check("première visite : tout écrit", r.toUpsert.length === 10 && r.skipped === 0);
    r = selectChaptersToUpsert(scraped, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 5);
    check("rien de neuf : seuls les 5 derniers réécrits", r.toUpsert.map((c) => c.chapter_number).join() === "6,7,8,9,10" && r.skipped === 5, r);
    r = selectChaptersToUpsert(scraped, new Set([1, 2, 3, 4, 5, 6, 7, 8]), 5);
    check("2 nouveaux : nouveaux + fenêtre, sans doublon", r.toUpsert.map((c) => c.chapter_number).join() === "6,7,8,9,10", r);
    r = selectChaptersToUpsert([chapter(50)], new Set([1, 2, 3]), 5);
    check("🔴 un chapitre absent de la base est TOUJOURS écrit", r.toUpsert.length === 1);
    r = selectChaptersToUpsert(scraped, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 0);
    check("fenêtre à 0 : plus aucune réécriture", r.toUpsert.length === 0 && r.skipped === 10);
    r = selectChaptersToUpsert([chapter(3), chapter(1), chapter(2)], new Set([1, 2, 3]), 2);
    check("ordre d'arrivée indifférent", r.toUpsert.map((c) => c.chapter_number).sort().join() === "2,3", r);
    r = selectChaptersToUpsert([chapter(10.5), chapter(10), chapter(11)], new Set([10, 10.5, 11]), 2);
    check("numéros décimaux gérés", r.toUpsert.map((c) => c.chapter_number).sort((a, b) => a - b).join() === "10.5,11", r);
  }

  console.log("\n— Ordonnancement des sources : identique à la logique dupliquée d'avant");
  {
    const reference = (enabled: ScraperConfig[], normalizedType: string) => {
      const prioritized: ScraperConfig[] = [];
      for (const config of enabled) {
        if (config.type === "multiple") prioritized.unshift(config);
        else if (config.type === normalizedType) prioritized.push(config);
      }
      return prioritized;
    };
    const manager = new ScraperManager();
    const all = manager.getAvailableScrapers();
    for (const type of ["manga", "manhwa", "unknown"]) {
      const actual = (manager as unknown as { orderScrapersForType(c: ScraperConfig[], t: string): ScraperConfig[] })
        .orderScrapersForType(all, type).map((c) => c.name);
      const expected = reference(all, type).map((c) => c.name);
      check(`ordre inchangé pour « ${type} »`, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
    }
  }

  console.log("\n— Synchro des providers : une requête, pas des milliers");
  {
    const manager = new ScraperManager() as unknown as {
      syncWithDatabase(): Promise<void>; ensureInitialized(): Promise<void>; initialized: boolean;
    };
    let calls = 0;
    manager.syncWithDatabase = async () => { calls++; await sleep(20); manager.initialized = true; };
    await Promise.all(Array.from({ length: 24 }, () => manager.ensureInitialized()));
    check("24 appels concurrents : 1 seule requête", calls === 1, calls);
    await manager.ensureInitialized();
    check("une fois initialisé : plus aucune requête", calls === 1, calls);
  }
  {
    const manager = new ScraperManager() as unknown as {
      syncWithDatabase(): Promise<void>; ensureInitialized(): Promise<void>;
    };
    let calls = 0;
    // Le vrai `syncWithDatabase` avale ses erreurs et rend la main sans marquer
    // `initialized` : c'est CE cas qui rejouait la requête à chaque appel.
    manager.syncWithDatabase = async () => { calls++; };
    await Promise.all(Array.from({ length: 24 }, () => manager.ensureInitialized()));
    for (let i = 0; i < 100; i++) await manager.ensureInitialized();
    check("🔴 synchro en échec : cooldown, pas 124 requêtes", calls === 1, calls);
  }

  console.log("\n— Orchestration bout en bout (scrapers doublés)");
  {
    const { manager } = fakeManager(async () => [chapter(1), chapter(2)]);
    const out = await manager.scrapeWithAllProviders("Série", "manga");
    check("5 sources compatibles répondent", out.results.length === 5 && out.attempted === 5, out.attempted);
    check("aucune erreur, aucune source écartée", out.errors.length === 0 && out.skipped.length === 0);
    check("waitedMs nul sans limite par source", out.waitedMs === 0);
  }
  {
    const { manager } = fakeManager(async (name) => {
      if (name === "MangaDex") throw new Error("HTTP 503");
      return [chapter(1)];
    });
    const out = await manager.scrapeWithAllProviders("Série", "manga");
    check("la source en panne est isolée, les autres passent", out.results.length === 4 && out.errors.length === 1);
    check("l'erreur est nommée et son message conservé", out.errors[0]?.provider === "MangaDex" && out.errors[0]?.message === "HTTP 503", out.errors[0]);
  }
  {
    const { manager } = fakeManager(async () => []);
    const out = await manager.scrapeWithAllProviders("Série", "manga");
    check("🔴 tout vide SANS exception : 0 résultat mais 0 erreur (série absente, pas panne)",
      out.results.length === 0 && out.errors.length === 0 && out.attempted === 5, out);
  }
  {
    const { manager } = fakeManager(async () => { throw new Error("down"); });
    const out = await manager.scrapeWithAllProviders("Série", "manga");
    check("🔴 tout casse : attempted === errors.length, l'échec est détectable",
      out.attempted === 5 && out.errors.length === 5, { attempted: out.attempted, errors: out.errors.length });
  }
  {
    const { manager } = fakeManager(async () => [chapter(1)]);
    manager.enableSourceLimits(1);
    let inFlight = 0, peak = 0;
    const scrapers = (manager as unknown as { scrapers: Map<string, unknown> }).scrapers;
    for (const key of [...scrapers.keys()]) {
      scrapers.set(key, { scrapeChapters: async () => {
        inFlight++; peak = Math.max(peak, inFlight); await sleep(40); inFlight--; return [chapter(1)];
      } });
    }
    const [a, b] = await Promise.all([
      manager.scrapeWithAllProviders("A", "manga"),
      manager.scrapeWithAllProviders("B", "manga"),
    ]);
    check("limite 1/source tenue sur 2 séries concurrentes", peak === 5, { peak });
    check("l'attente est mesurée pour la série en file", Math.max(a.waitedMs, b.waitedMs) >= 30, { a: a.waitedMs, b: b.waitedMs });
    check("🔴 l'attente n'entre PAS dans busyMs", Math.max(a.busyMs, b.busyMs) < 80, { a: a.busyMs, b: b.busyMs });
  }
  {
    const { manager, calls } = fakeManager(async (name) => {
      if (name === "MangaDex") throw new Error("down");
      return [chapter(1)];
    });
    manager.enableCircuitBreaker(3);
    for (let i = 0; i < 3; i++) await manager.scrapeWithAllProviders(`S${i}`, "manga");
    check("coupé après 3 erreurs consécutives", manager.trippedProviders().join() === "MangaDex", manager.trippedProviders());
    const before = calls.filter((c) => c === "MangaDex").length;
    const out = await manager.scrapeWithAllProviders("S4", "manga");
    check("plus aucun appel à la source coupée", calls.filter((c) => c === "MangaDex").length === before);
    check("elle est signalée dans skipped, attempted retombe à 4", out.skipped.join() === "MangaDex" && out.attempted === 4, out);
    check("les autres sources continuent", out.results.length === 4);
  }
  {
    const { manager } = fakeManager(async () => { throw new Error("down"); });
    manager.enableCircuitBreaker(1);
    await manager.scrapeWithAllProviders("S0", "manga");
    const out = await manager.scrapeWithAllProviders("S1", "manga");
    check("🔴 toutes coupées : attempted=0 MAIS skipped non vide (l'appelant doit voir l'échec)",
      out.attempted === 0 && out.skipped.length === 5, { attempted: out.attempted, skipped: out.skipped.length });
  }

  console.log(
    failures === 0
      ? `\n✅ ${passed} assertions, aucune en échec`
      : `\n❌ ${failures} échec(s) sur ${passed + failures} assertions`
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("\n❌ selfcheck crashed:", error);
  process.exit(1);
});

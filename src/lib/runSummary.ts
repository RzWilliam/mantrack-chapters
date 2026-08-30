/**
 * Bilan d'un run du cron chapitres.
 *
 * ⚠️ Raison d'être : deux tours d'optimisation (2026-08-30) n'ont pas bougé la
 * durée d'un run — 632 s → 639 s — faute de savoir OÙ passait le temps. Le
 * nombre de séries réellement traitées et le coût par provider n'existaient que
 * noyés dans les logs. Ils vont désormais dans le résumé de run GitHub
 * (`$GITHUB_STEP_SUMMARY`), lisible sans dérouler une ligne de log.
 *
 * Séparé du script de cron pour être testable sans base de données.
 */

import { appendFileSync } from "node:fs";
import type { ProviderAggregate } from "./scraperStats";

/** Formate une durée : `840ms`, `2.9s`, `1m04s`. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Percentile (rang le plus proche) sur une liste **déjà triée**. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  );
  return sorted[i];
}

export interface RunSummaryInput {
  seriesWithChapters: number;
  needingUpdate: number;
  succeeded: number;
  chaptersWritten: number;
  totalMs: number;
  concurrency: number;
  batchDelayMs: number;
  updateIntervalHours: number;
  /** Durée du scrape de chaque série, dans n'importe quel ordre. */
  mangaDurations: number[];
  providers: ProviderAggregate[];
}

/**
 * Assemble le bilan en Markdown.
 *
 * À lire dans cet ordre : ① combien de séries ont réellement été traitées —
 * c'est le dénominateur qui manquait pour dimensionner quoi que ce soit ; ② la
 * distribution par série, une médiane basse avec un p95 élevé signant une longue
 * traîne plutôt qu'un coût uniforme ; ③ le tableau par provider, trié par temps
 * total, qui désigne la source qui cadence le run (les providers d'une série
 * tournent en parallèle : elle coûte le temps du plus lent).
 */
export function buildRunSummary(input: RunSummaryInput): string[] {
  const sorted = [...input.mangaDurations].sort((a, b) => a - b);
  const scrapeMs = sorted.reduce((sum, ms) => sum + ms, 0);
  // Part du temps du pool réellement passée à scraper. Proche de 100 % => le run
  // est bien borné par les sources amont ; nettement en dessous => le temps part
  // ailleurs (base, délais de politesse, attente) et c'est là qu'il faut creuser.
  const busy = input.totalMs
    ? (100 * scrapeMs) / (input.totalMs * input.concurrency)
    : 0;

  return [
    `## 📚 Chapter update — ${new Date().toISOString()}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Series with chapters | ${input.seriesWithChapters} |`,
    `| Needing update (>${input.updateIntervalHours}h, excl. Finished/Discontinued) | ${input.needingUpdate} |`,
    `| Updated successfully | ${input.succeeded} / ${input.needingUpdate} |`,
    `| Chapters written | ${input.chaptersWritten} |`,
    `| Total duration | ${fmtMs(input.totalMs)} |`,
    `| Concurrency | ${input.concurrency} (delay ${input.batchDelayMs}ms/series) |`,
    `| Pool time spent scraping | ${busy.toFixed(0)}% |`,
    "",
    "### Per series",
    "",
    `median ${fmtMs(percentile(sorted, 50))} · p95 ${fmtMs(
      percentile(sorted, 95)
    )} · max ${fmtMs(sorted[sorted.length - 1] ?? 0)}`,
    "",
    "A series costs as much as its slowest provider — they all run in parallel.",
    "A low median with a high p95 means a long tail, not a uniform cost.",
    "",
    "### Per provider",
    "",
    "Sorted by total time: the pace-setter comes first.",
    "",
    "| Provider | Attempts | With chapters | Empty | Errors | Median | p95 | Max |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...input.providers.map(
      (a) =>
        `| ${a.provider} | ${a.attempts} | ${a.withChapters} | ${a.empty} | ${
          a.errors
        } | ${fmtMs(a.medianMs)} | ${fmtMs(a.p95Ms)} | ${fmtMs(a.maxMs)} |`
    ),
    "",
    "⚠️ `Empty` is not proof a series is absent from that provider: every scraper",
    "catches its own errors and returns `[]`, so a silent breakage looks the same.",
    "A column jumping for one source is the signal to investigate.",
  ];
}

/** Écrit le bilan sur la sortie standard et, sous GitHub Actions, dans le résumé du run. */
export function writeRunSummary(lines: string[]): void {
  const report = lines.join("\n");
  console.log(`\n${report}\n`);

  // Hors GitHub Actions (exécution locale), la variable n'existe pas : le
  // console.log ci-dessus suffit.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${report}\n`);
  } catch (error) {
    // Un résumé est un confort : il ne doit jamais faire échouer le job.
    console.warn("⚠️ Could not write the run summary:", error);
  }
}

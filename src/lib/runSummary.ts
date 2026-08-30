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
  /** Séries réellement traitées. < `needingUpdate` si la deadline douce a coupé le run. */
  processed: number;
  /** Séries laissées au run suivant parce que la deadline a été atteinte. */
  skippedForDeadline: number;
  succeeded: number;
  chaptersWritten: number;
  totalMs: number;
  concurrency: number;
  batchDelayMs: number;
  updateIntervalHours: number;
  /** Durée bout en bout de chaque série (latence vécue), dans n'importe quel ordre. */
  mangaDurations: number[];
  /**
   * Coût utile de chaque série : son provider le plus lent, attente d'un jeton EXCLUE.
   * ⚠️ C'est ce tableau — et non `mangaDurations` — qui doit servir au taux
   * d'occupation : depuis la limite par source, une part de la latence est de la file
   * d'attente, et la compter comme du scraping ferait tendre le taux vers 100 % quoi
   * qu'il arrive, exactement au moment où on en a besoin pour régler cette limite.
   */
  mangaBusyDurations: number[];
  /** Attente d'un jeton de source par série. Vide/nul si les limites sont désactivées. */
  mangaWaitDurations: number[];
  /** Limite de concurrence par source (0 = désactivée). */
  sourceConcurrency: number;
  /** Répartition des séries candidates par palier de cadence (vide si cadence uniforme). */
  tierBreakdown: Array<{ label: string; intervalHours: number; candidates: number }>;
  providers: ProviderAggregate[];
  /** Sources coupées par le coupe-circuit pendant ce run. */
  trippedProviders: string[];
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
  const waits = [...input.mangaWaitDurations].sort((a, b) => a - b);

  const capacityMs = input.totalMs * input.concurrency;
  const scrapeMs = input.mangaBusyDurations.reduce((sum, ms) => sum + ms, 0);
  const waitMs = input.mangaWaitDurations.reduce((sum, ms) => sum + ms, 0);

  // Part du temps du pool réellement passée à scraper. Proche de 100 % => le run
  // est bien borné par les sources amont ; nettement en dessous => le temps part
  // ailleurs (base, délais de politesse, attente) et c'est là qu'il faut creuser.
  const busy = capacityMs ? (100 * scrapeMs) / capacityMs : 0;
  // Part passée à attendre un jeton de source. C'est le prix de la limite par source :
  // s'il grimpe, c'est cette limite — et non la concurrence globale — qui cadence le run.
  const queued = capacityMs ? (100 * waitMs) / capacityMs : 0;

  const alerts = buildProviderAlerts(input.providers);

  return [
    `## 📚 Chapter update — ${new Date().toISOString()}`,
    "",
    ...(alerts.length
      ? ["> 🔴 **Alerts**", ...alerts.map((a) => `> - ${a}`), ""]
      : []),
    ...(input.trippedProviders.length
      ? [
          `> ⛔ **Circuit breaker opened** for: ${input.trippedProviders.join(", ")}`,
          "> That source failed repeatedly and was skipped for the rest of the run.",
          "",
        ]
      : []),
    "| Metric | Value |",
    "|---|---|",
    `| Series with chapters | ${input.seriesWithChapters} |`,
    `| Needing update (${
      input.tierBreakdown.length
        ? "per-tier cadence"
        : `>${input.updateIntervalHours}h`
    }, excl. Finished/Discontinued) | ${input.needingUpdate} |`,
    `| Processed this run | ${input.processed}${
      input.skippedForDeadline
        ? ` (${input.skippedForDeadline} left for the next run — deadline reached)`
        : ""
    } |`,
    `| Updated successfully | ${input.succeeded} / ${input.processed} |`,
    `| Chapters written | ${input.chaptersWritten} |`,
    `| Total duration | ${fmtMs(input.totalMs)} |`,
    `| Concurrency | ${input.concurrency} series${
      input.sourceConcurrency ? `, ${input.sourceConcurrency}/source` : ""
    } (delay ${input.batchDelayMs}ms/series) |`,
    `| Pool time spent scraping | ${busy.toFixed(0)}% |`,
    ...(input.sourceConcurrency
      ? [`| Pool time queued on source limits | ${queued.toFixed(0)}% |`]
      : []),
    "",
    ...(input.tierBreakdown.length
      ? [
          "### Refresh tiers",
          "",
          "Candidates per tier, before the staleness filter. A dormant series does not",
          "need the same cadence as one publishing weekly.",
          "",
          "| Tier | Interval | Candidates |",
          "|---|---:|---:|",
          ...input.tierBreakdown.map(
            (t) => `| ${t.label} | ${t.intervalHours}h | ${t.candidates} |`
          ),
          "",
        ]
      : []),
    "### Per series",
    "",
    `median ${fmtMs(percentile(sorted, 50))} · p95 ${fmtMs(
      percentile(sorted, 95)
    )} · max ${fmtMs(sorted[sorted.length - 1] ?? 0)}`,
    ...(input.sourceConcurrency
      ? [
          "",
          `queued for a source slot — median ${fmtMs(
            percentile(waits, 50)
          )} · p95 ${fmtMs(percentile(waits, 95))}`,
        ]
      : []),
    "",
    "A series costs as much as its slowest provider — they all run in parallel.",
    "A low median with a high p95 means a long tail, not a uniform cost.",
    "The figures above are end-to-end latency; the occupancy rate uses scraping time",
    "only, so queueing never inflates it.",
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
    "⚠️ `Errors` counts sources that threw — since the error contract landed",
    "(`src/scrapers/types.ts`), a breakage no longer hides behind an empty result.",
    "`Empty` still deserves a look though: a scraper whose selector stopped matching",
    "returns a perfectly legitimate-looking `[]`. A column jumping for one source is",
    "the signal to investigate — and above a threshold it now raises an alert.",
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


/**
 * Seuils d'alerte — volontairement STRICTS.
 *
 * ⚠️ Le workflow se déclenche 48 fois par jour. Une alerte qui se déclenche pour un
 * hoquet réseau serait coupée par son destinataire en moins d'une semaine, et on
 * reviendrait à l'état d'avant : découvrir une source morte des semaines après.
 * Ces seuils ne visent QUE la panne franche, sur un échantillon suffisant.
 */
export const ALERT_MIN_ATTEMPTS = 50;
export const ALERT_ERROR_RATE = 0.8;
export const ALERT_EMPTY_RATE = 0.98;

/**
 * Sources dont le comportement sur ce run justifie une alerte.
 *
 * Deux motifs distincts :
 *   - trop d'erreurs → la source lève (réseau, HTTP, parsing) : panne visible ;
 *   - quasiment que des vides → la source répond mais ne matche plus rien : panne
 *     SILENCIEUSE, le cas Weeb Central qui a mis des semaines à être vu. Un scraper
 *     dont le sélecteur ne matche plus renvoie un `[]` parfaitement légitime en
 *     apparence — seul le taux, sur tout le catalogue, le trahit.
 */
export function buildProviderAlerts(
  providers: ProviderAggregate[],
  minAttempts = ALERT_MIN_ATTEMPTS
): string[] {
  const alerts: string[] = [];

  for (const p of providers) {
    if (p.attempts < minAttempts) continue;

    const errorRate = p.errors / p.attempts;
    if (errorRate > ALERT_ERROR_RATE) {
      alerts.push(
        `${p.provider}: ${(100 * errorRate).toFixed(0)}% errors over ${p.attempts} attempts`
      );
      continue;
    }

    const emptyRate = p.empty / p.attempts;
    if (emptyRate > ALERT_EMPTY_RATE) {
      alerts.push(
        `${p.provider}: ${(100 * emptyRate).toFixed(0)}% empty over ${p.attempts} attempts — likely a silent breakage`
      );
    }
  }

  return alerts;
}

/**
 * Publie les alertes en annotations GitHub (`::warning::`), visibles en tête de run
 * sans ouvrir les logs. Ne fait PAS échouer le job : l'échec est réservé à la panne
 * totale (cf. le point d'entrée du cron), sinon le rouge devient du bruit.
 */
export function emitAlerts(alerts: string[]): void {
  for (const alert of alerts) {
    console.log(`::warning title=Chapter cron::${alert}`);
  }
}

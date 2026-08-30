/**
 * Collecteur de statistiques de scraping — pour le cron uniquement.
 *
 * ⚠️ Raison d'être : deux tours d'optimisation du cron (2026-08-30) n'ont pas
 * bougé la durée d'un run (632 s → 639 s), faute de savoir OÙ passent ces
 * 11 minutes. Le nombre de séries traitées et le temps par provider ne sont
 * visibles que noyés dans les logs. On les publie donc dans le résumé de run.
 *
 * 🔴 **Désactivé par défaut.** `scraperManager` est un singleton importé aussi par
 * l'application (process serveur de longue durée) : accumuler une ligne par
 * scrape y serait une fuite mémoire. Seul le script du cron appelle `enable()`,
 * et il vit le temps d'un run.
 */

/** Issue d'un appel à un provider pour une série. */
import { percentile } from "./runSummary";

export type ProviderOutcome =
  /** Le provider a renvoyé au moins un chapitre. */
  | "chapters"
  /** Appel abouti, mais aucun chapitre (série absente chez ce provider… ou panne silencieuse). */
  | "empty"
  /** Le scraper a levé une exception (réseau, timeout, HTML inattendu…). */
  | "error";

interface Sample {
  provider: string;
  ms: number;
  outcome: ProviderOutcome;
  chapters: number;
}

export interface ProviderAggregate {
  provider: string;
  attempts: number;
  withChapters: number;
  empty: number;
  errors: number;
  chapters: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export class ScraperStats {
  private enabled = false;
  private samples: Sample[] = [];

  /** À n'appeler QUE depuis un process court (le cron). Cf. avertissement en tête. */
  enable(): void {
    this.enabled = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  record(sample: Sample): void {
    if (!this.enabled) return;
    this.samples.push(sample);
  }

  reset(): void {
    this.samples = [];
  }

  /** Agrégats par provider, triés par temps total décroissant (le plus coûteux d'abord). */
  aggregates(): ProviderAggregate[] {
    const byProvider = new Map<string, Sample[]>();
    for (const s of this.samples) {
      const list = byProvider.get(s.provider);
      if (list) list.push(s);
      else byProvider.set(s.provider, [s]);
    }

    return [...byProvider.entries()]
      .map(([provider, list]) => {
        const durations = list.map((s) => s.ms).sort((a, b) => a - b);
        return {
          provider,
          attempts: list.length,
          withChapters: list.filter((s) => s.outcome === "chapters").length,
          empty: list.filter((s) => s.outcome === "empty").length,
          errors: list.filter((s) => s.outcome === "error").length,
          chapters: list.reduce((sum, s) => sum + s.chapters, 0),
          medianMs: percentile(durations, 50),
          p95Ms: percentile(durations, 95),
          maxMs: durations[durations.length - 1] ?? 0,
        };
      })
      .sort((a, b) => b.medianMs * b.attempts - a.medianMs * a.attempts);
  }
}

export const scraperStats = new ScraperStats();

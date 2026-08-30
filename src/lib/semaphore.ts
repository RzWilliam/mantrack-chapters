/**
 * Sémaphore de comptage minimal — borne le nombre d'opérations concurrentes.
 *
 * ⚠️ Raison d'être : la concurrence du cron était globale (`CRON_CONCURRENCY`
 * séries en parallèle), et c'est ELLE qui bornait accessoirement la charge par
 * source — 4 séries en vol × 1 requête par source = 4 requêtes concurrentes chez
 * chacune. Impossible donc de monter le débit sans marteler les sources d'autant.
 *
 * En déplaçant la limite *sur la source*, les deux réglages se séparent : on peut
 * traiter 8 séries de front tout en garantissant à chaque source exactement la même
 * charge qu'avant. Une série bloquée sur une source lente cesse d'immobiliser un
 * worker qui pourrait avancer sur une autre.
 */
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** Nombre d'appelants actuellement en attente d'un jeton (pour l'observabilité). */
  get pending(): number {
    return this.waiting.length;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // Le jeton est transmis DIRECTEMENT par `release` (`active` n'est jamais
    // décrémenté dans ce cas) : sans cette passation, deux réveils concurrents
    // pourraient tous deux se croire sous la limite.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * Exécute `fn` sous le sémaphore, en lui passant le temps passé À ATTENDRE le
   * jeton : sans cette mesure, l'attente en file se ferait compter comme du temps
   * de scraping et le taux d'occupation du bilan de run deviendrait un mensonge.
   */
  async run<T>(fn: (waitedMs: number) => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    await this.acquire();
    const waitedMs = Date.now() - queuedAt;
    try {
      return await fn(waitedMs);
    } finally {
      this.release();
    }
  }
}

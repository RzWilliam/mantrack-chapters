/**
 * Réglages HTTP partagés par les scrapers.
 *
 * ⚠️ Pourquoi ce fichier existe : `fetch` (Node/undici) n'a AUCUN timeout de
 * réponse par défaut. Une source amont qui accepte la connexion puis ne répond
 * jamais immobilisait un worker du pool du cron jusqu'au timeout kernel (~2 min
 * ou plus). Avec `CRON_CONCURRENCY = 4`, deux sockets zombies = débit divisé par
 * deux, et un run dont la durée devient imprévisible.
 *
 * Toute requête sortante d'un scraper DOIT donc être bornée :
 *   - `fetch`        → `signal: scraperSignal()`
 *   - `gotScraping`  → `timeout: { request: SCRAPER_TIMEOUT_MS }`
 *
 * Le budget est volontairement large (25 s) devant une requête saine (1-3 s) :
 * on ne coupe que des sockets déjà morts, jamais une source simplement lente.
 */

/** Budget par requête HTTP, en millisecondes. Surchargeable via `SCRAPER_TIMEOUT_MS`. */
export const SCRAPER_TIMEOUT_MS =
  Number(process.env.SCRAPER_TIMEOUT_MS) || 25_000;

/**
 * Signal d'abandon à passer à `fetch`. Un signal est à usage unique : appeler
 * cette fonction à CHAQUE requête, ne jamais partager le résultat.
 *
 * À l'expiration, `fetch` rejette avec une `TimeoutError` — rattrapée par le
 * `try/catch` du scraper (→ 0 chapitre pour cette source) ou, si elle remonte,
 * par le `Promise.allSettled` de `scrapeWithAllProviders`. Les autres providers
 * de la même série ne sont pas affectés.
 */
export function scraperSignal(): AbortSignal {
  return AbortSignal.timeout(SCRAPER_TIMEOUT_MS);
}

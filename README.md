# mantrack-chapters

The **chapters layer** of [ManTrack](https://mantrack.vercel.app): the 6 scan-site scrapers,
their orchestrator, the service that writes chapters to the database, and the **GitHub Actions
cron** that refreshes all of it every 2 hours.

This repo is two things at once:

- **a package** (`@mantrack/chapters`) consumed by the ManTrack app (private repo);
- **a standalone scheduled job**, which runs here and writes straight to Supabase.

> ⚠️ **No series metadata lives here.** Titles, synopses, scores and genres come from the
> Jikan / MyAnimeList API and stay in the app (`localMangaService`). This repo only deals with
> **chapters**. Two distinct layers — don't conflate them.

## Why this repo is separate (and public)

The cron burns **~11 min per run × 12 runs/day ≈ 3,400 Actions minutes per month**. A **private**
repo only gets 2,000 free minutes/month, and going over **blocks every workflow in the repo**.
Minutes are unlimited on **public** repos only.

Hence the split: the application (UI, admin back-office, business logic) stays **private**, and
only this scraping layer — which holds nothing confidential — lives here, in the open, where the
cron can run without a quota.

No secrets are committed: the Supabase keys live in this repo's *GitHub Secrets* (see
[Configuration](#configuration)).

## What's inside

```
src/
├── index.ts                  package entry point (what the app imports)
├── types.ts                  Provider, Chapter, ChapterWithProvider, ScrapedChapter…
├── chapterService.ts         reads/writes chapters in the database
├── lib/
│   ├── supabase.ts           anon client (public data)
│   ├── supabaseAdmin.ts      service-role client — SERVER ONLY
│   ├── simpleCache.ts        in-memory TTL cache
│   ├── http.ts               shared request timeout — every outgoing call must be bounded
│   ├── scraperStats.ts       per-provider timings, collected by the cron only
│   └── runSummary.ts         the run report written to $GITHUB_STEP_SUMMARY
├── scrapers/
│   ├── types.ts              the `MangaScraper` interface — a provider's contract
│   ├── scraperManager.ts     orchestrator: selection, parallelism, enable/disable
│   ├── asuraComicScraper.ts
│   ├── mangadexScraper.ts
│   ├── mangaParkScraper.ts
│   ├── mangaPillScraper.ts
│   ├── weebCentralScraper.ts
│   └── mangaKatanaScraper.ts
└── cron/
    └── update-chapters.ts    the scheduled job (workflow entry point)
```

> Code comments are in **French**, matching the rest of the ManTrack codebase. Everything
> user-facing here — README, commit messages — is in **English**.

## Configuration

Three secrets, set under **Settings → Secrets and variables → Actions**:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (public reads) |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔴 Service-role key — writes, bypasses RLS. Never client-side. |

A few optional knobs, via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CRON_CONCURRENCY` | `4` | mangas processed in parallel — also settable per-run via `workflow_dispatch` |
| `CRON_BATCH_DELAY` | `300` ms | pause after each manga, to stay polite with upstream sources |
| `SCRAPER_TIMEOUT_MS` | `25000` | per-request budget for every outgoing scraper request |
| `CRON_MAX_RUN_MS` | `2700000` (45 min) | soft deadline: stop picking new series, finish cleanly |
| `CRON_FLUSH_EVERY` | `200` | successes buffered before timestamps are written |
| `CRON_BREAKER_THRESHOLD` | `10` | consecutive errors before a source is dropped for the rest of the run |

> ⚠️ **The soft deadline is not the job timeout.** `timeout-minutes: 60` kills the process:
> whatever had not been written is lost. `CRON_MAX_RUN_MS` sits well below it so the run ends on
> its own terms — timestamps flushed, report published — and leaves the untouched series to the
> next run. Timestamps are also written every `CRON_FLUSH_EVERY` successes rather than once at the
> very end, so a run that dies anyway keeps most of its work.

> ⚠️ **Every outgoing request must be bounded** (`src/lib/http.ts`). Node's `fetch` has no
> response timeout by default: a source that accepts the connection then never answers used to
> pin one of the pool's workers until the kernel gave up. With `CRON_CONCURRENCY = 4`, two dead
> sockets halved the throughput and made the run's duration unpredictable. Use
> `signal: scraperSignal()` on `fetch`, `timeout: { request: SCRAPER_TIMEOUT_MS }` on
> `gotScraping`. The budget is deliberately wide compared to a healthy request (1-3 s): it only
> ever cuts sockets that are already dead.

Locally, a gitignored `.env` is enough:

```bash
npm install
npm run cron:update-chapters   # runs the real job — writes to the database
npm run typecheck
```

## Schedule — why it fires every 30 minutes

The workflow triggers `*/30 * * * *`, but that is **not** the refresh rate. The script only
touches series older than `UPDATE_INTERVAL_HOURS` (2h), so a surplus trigger finds nothing and
exits in ~30s. The frequency exists to work around GitHub, not to scrape more.

Measured on 2026-08-30, over the first 8 runs with `0 */2 * * *`: **not one run started on the
hour** (:28, :17, :50, :05, :39, :37) and the real gaps ranged from **1.98h to 6.57h**. The
`schedule` event is best-effort — deprioritised under load, and triggers are silently dropped,
especially at `:00`, the busiest minute of all. Firing often is the only reliable way to land
close to the intended 2h.

It also fixes a subtler problem: the 2h window is measured from the **end** of the previous
update. A run lasting ~11 minutes meant a perfectly punctual 2-hourly trigger found the tail of
the catalogue at 1h49 and did nothing.

⚠️ The workflow-level `concurrency` guard is **not optional** with this cadence: two runs must
never scrape at the same time (upstream sources hit twice, concurrent writes on the same series).

## Reading a run

Each run publishes a report to the job summary — no need to unfold a single log line:

- how many series were **actually processed** (the denominator you need before sizing anything);
- the **per-series** distribution (a low median with a high p95 means a long tail, not a uniform
  cost);
- a **per-provider** table sorted by total time, naming the source that paces the run — since a
  series costs as much as its slowest provider, they all run in parallel.

`Errors` is now trustworthy: since the **error contract** landed (`src/scrapers/types.ts`), a
scraper returns `[]` only for "not found here" and lets network, HTTP, timeout and parsing
failures propagate. A breakage no longer hides behind an empty result.

> ⚠️ `Empty` still deserves a look. A scraper whose selector stopped matching returns a
> perfectly legitimate-looking `[]` — no exception, nothing to catch. Only the *rate*, across the
> whole catalogue, gives it away. A column jumping for one source is the signal to go and look.

This exists because two rounds of optimisation (2026-08-30) failed to move a run's duration
(632s → 639s) — nobody knew where the 11 minutes went.

## When something breaks

A report nobody opens alerts nobody. Two mechanisms, deliberately unequal:

- **`::warning::` annotations**, shown at the top of the run without opening the logs. Raised when
  a source crosses a threshold over at least 50 attempts: **>80% errors**, or **>98% empties** —
  the signature of a silent breakage. Also raised when the circuit breaker opens.
- **The job fails (red, notification)** in exactly one case: the run had work to do and **not a
  single series** could be updated. Nothing else. The workflow fires 48 times a day; an alert that
  cries over a partial degradation gets muted within a week, and then you're back to discovering a
  dead source weeks later.

The **circuit breaker** sits alongside: after `CRON_BREAKER_THRESHOLD` consecutive errors on one
source (any success resets the count), it is skipped for the rest of the run — a dead source would
otherwise cost a full `SCRAPER_TIMEOUT_MS` on every remaining series. It resets on the next run,
and the report names it. A rate-limiting source can get dropped for a run: that's the accepted
trade.

⚠️ A series is a **success** only if at least one source answered *without throwing*. "Found in no
provider" stays a success — the series is legitimately absent, and failing it would re-scrape it
forever. "Every source threw" is a failure: no timestamp advanced, retried next run.

## Adding or removing a provider

Everything happens **here**, in a single commit:

1. Create `src/scrapers/myScraper.ts` implementing `MangaScraper` (`src/scrapers/types.ts`).
2. Register it in `src/scrapers/scraperManager.ts` (import + config entry).
3. Export it from `src/scrapers/index.ts` and, if the app needs it directly, `src/index.ts`.
4. Run `npm run typecheck`, then commit to `main`.

**On the cron side: it's live on the next run**, nothing else to do.

**On the app side**, the app pins a commit of this repo in its `package-lock.json`. Chapters
scraped by a new provider already show up in the app without any change (it reads them from the
database). But for the app to *know* the scraper — to list it under `/admin/providers`, and to
use it in its own on-demand scraping — run over there:

```bash
npm update @mantrack/chapters && git commit -am "⬆️ deps: new provider" && git push
```

The next Vercel deploy picks it up.

## Pinned versions

`cheerio`, `got-scraping` and `@supabase/supabase-js` are pinned to **exact** versions, on
purpose: the cron must scrape with exactly the same libraries as production. `cheerio@1.2.0`,
for one, already breaks compilation (its `Cheerio` type became generic). Bump them here first,
then propagate to the app.

## How the app consumes this package

The package ships as **TypeScript source**, with no build step: the cron runs it through `tsx`,
and the app compiles it through `transpilePackages` — so the exact same SWC pipeline as before
the extraction. That's also what preserves the dynamic `import()` of `got-scraping` (ESM-only),
which a CommonJS build would turn into a `require()` and break at runtime.

```ts
import { chapterService, scraperManager, type ChapterWithProvider } from "@mantrack/chapters";
```

> ⚠️ The app must depend on this repo via an explicit **`git+https://`** URL, not the `github:`
> shorthand: with an SSH key present, npm resolves the shorthand to `git+ssh://` and writes that
> into the lockfile — and Vercel has no GitHub SSH key.

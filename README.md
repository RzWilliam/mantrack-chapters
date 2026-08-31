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
│   ├── semaphore.ts          per-source concurrency limit
│   ├── refreshTiers.ts       adaptive cadence — how often a series is re-scraped
│   ├── chapterDelta.ts       which chapters actually need writing
│   └── runSummary.ts         the run report written to $GITHUB_STEP_SUMMARY
├── scrapers/
│   ├── types.ts              the `MangaScraper` interface — a provider's contract
│   ├── scraperManager.ts     orchestrator: selection, parallelism, enable/disable
│   ├── asuraComicScraper.ts
│   ├── mangadexScraper.ts
│   ├── mangaParkScraper.ts
│   ├── mangaPillScraper.ts
│   ├── weebCentralScraper.ts
│   ├── mangaKatanaScraper.ts
│   └── wpComicScraper.ts     generic WordPress scraper — one entry per site, no new code
├── cron/
│   └── update-chapters.ts    the scheduled job (workflow entry point)
└── sql/
    └── get_chapters_manga_activity.sql   RPC feeding the adaptive cadence
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
| `CRON_CONCURRENCY` | `8` | series processed in parallel — also settable per-run via `workflow_dispatch` |
| `CRON_SOURCE_CONCURRENCY` | `4` | concurrent requests **per source** (`0` disables the limit) |
| `CRON_TIERS` | `9:2,30:6,*:24` | adaptive cadence, `ageInDays:intervalInHours` |
| `CHAPTER_REFRESH_WINDOW` | `5` | most recent chapters always rewritten, even if already stored |
| `CHAPTER_DELTA_UPSERT` | on | set to `0` to restore the full rewrite of every chapter |
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

> ⚠️ **`CRON_CONCURRENCY` no longer bounds the load on a source.** It used to, by
> accident: 4 series in flight meant at most 4 concurrent requests per source, so raising
> throughput meant hammering upstream by the same factor. `CRON_SOURCE_CONCURRENCY` now owns
> that limit, which is why the default moved to 8 series — each source sees exactly the load
> it saw before (4), only the pointless waiting is gone. Lower the *source* number if you
> want to be gentler; raising the series number alone is now safe.

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
npm run selfcheck              # cron logic, no network, no database
```

`selfcheck` pins down the decisions you cannot read back from a production log — is that
source really tripped, does queueing count as scraping, is "found nowhere" a failure. Every one
of those answers has been wrong in production at some point; each is now a named assertion in
[`scripts/selfcheck.ts`](scripts/selfcheck.ts), with the reasoning in the test's own label. It
runs on every push alongside the typecheck.

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

## Refresh cadence — not every series deserves the same

Series are bucketed by the date of their **last seen chapter**, and each bucket has its own
interval (`CRON_TIERS`, `ageInDays:intervalInHours`, catch-all `*` required last):

| Tier | Last chapter | Re-scraped every |
|---|---|---|
| active | ≤ 9 days | 2h |
| slow | ≤ 30 days | 6h |
| dormant | older | 24h |

The catalogue is overwhelmingly dormant, so this is the biggest lever on a run's duration —
and it costs no freshness where freshness matters. Two deliberate guardrails:

- **the slowest tier is capped at 24h**, not a week. A dormant series that resumes must be
  picked up the same day;
- **the fastest tier reaches to 9 days, not 7.** At exactly 7, a weekly series sits on the
  boundary and the slightest late release drops it to the slow tier — right before its next
  chapter. The two days of slack absorb that;
- **the tier resets on its own** — `last_chapter_at` is the newest chapter we've *seen*, so a
  new chapter drops the series straight back into `active`.

This needs one RPC in Supabase: run [`sql/get_chapters_manga_activity.sql`](sql/get_chapters_manga_activity.sql).
**Deploy order doesn't matter.** Until that function exists the cron logs a warning, falls back
to `get_chapters_unique_manga_ids`, and every series lands in the *fastest* tier — which is
exactly the old uniform 2h behaviour. Nothing breaks while the SQL is pending.

## Writing chapters — delta, not a full rewrite

`saveChapters` used to re-upsert a series' **entire** history, for every source, every 2h:
roughly 150 rows × 6 sources × 12 runs a day, plus as many `update_chapters_updated_at` trigger
firings, to store zero or one new chapter. It now reads the chapter numbers already stored
(one indexed column, paginated) and writes only what is missing — plus the
`CHAPTER_REFRESH_WINDOW` most recent chapters the source currently shows.

That window is not padding: the full upsert was quietly doing something worth keeping, namely
correcting `link` and `release_date` when a source revises them. In practice it only ever
revises the latest chapters, so that's the zone we keep rewriting.

> ⚠️ **The "Chapters written" figure in the report will collapse**, from thousands to a
> handful. It was counting rewrites, not new chapters. The number was never meaningful before;
> it is now.

If anything looks off, `CHAPTER_DELTA_UPSERT=0` restores the previous behaviour without a
deploy. A failed read of the existing numbers also falls back to a full upsert on its own —
when in doubt the code writes too much, never too little.

## Reading a run

Each run publishes a report to the job summary — no need to unfold a single log line:

- how many series were **actually processed** (the denominator you need before sizing anything);
- the **per-series** distribution (a low median with a high p95 means a long tail, not a uniform
  cost);
- a **per-provider** table sorted by total time, naming the source that paces the run — since a
  series costs as much as its slowest provider, they all run in parallel;
- **how much of the pool went into scraping**, and how much went into *queueing on source
  limits*. The two are kept apart on purpose: the occupancy rate counts scraping time only, so
  waiting for a source slot can never inflate it. If the queueing share climbs, it's
  `CRON_SOURCE_CONCURRENCY` — not `CRON_CONCURRENCY` — that is pacing the run.

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

## Adding a WordPress site — config only, no new file

The long tail of manhwa is translated by small groups who each run their own
WordPress. [`wpComicScraper.ts`](src/scrapers/wpComicScraper.ts) covers them all from a single
implementation: **a site is a config entry**, not a file.

```ts
export const rokariComicsScraper = new WpComicScraper({
  name: "Rokari Comics",              // must match the ScraperConfig name exactly
  baseUrl: "https://rokaricomics.com",
  restPostType: undefined,            // set it when /wp-json/wp/v2/<type> answers
  searchPath: "/?s={q}&post_type=wp-manga",
  seriesPathPrefixes: ["/manga/"],
});
```

Chapters are extracted by **three strategies tried in order**, so a new site usually needs no
code at all:

1. **JSON-LD** (`@type: "Chapter"`) — the most stable *and* the most complete. On one theme
   measured, the DOM rendered only the last 8 chapters where the JSON-LD listed all 24, ISO
   dates included.
2. **Themesia markup** (`.eph-num`, `.chapternum`, `.chapterdate`) — Rokari and most Asura forks.
3. **Any link that looks like a chapter** — no date, but it survives a theme change.

> ⚠️ **This is not a Madara scraper**, despite what these sites look like. They share
> `wp-content` and `admin-ajax.php` because they are WordPress, nothing more: `admin-ajax.php`
> `action=manga_get_chapters` answers **400**. Themes differ, and so does the markup — hence the
> strategies rather than one fixed set of selectors.

> ⚠️ **The match threshold is 0.7 here, against 0.4 elsewhere.** Some of these themes don't
> filter server-side at all — one measured theme returned the same 39 series for *any* query,
> and the one you wanted was not even among them. With a low threshold the first series in the
> list would pass for a match and you'd write **another series' chapters**. Prefer
> `restPostType` whenever the site's REST API answers: it is a real server-side search.

### The one SQL step

`chapterService.fetchOrCreateProvider` creates the `providers` row on its own — but its
`INSERT` only sets `name` and `base_url`. `type` and `enabled` fall back to the table's
defaults, which gives you two ways to lose:

- **`type` NOT NULL with no default** → the insert fails, and the series update fails with it.
  Loud, so you'll see it.
- **`enabled` defaulting to `false` or NULL** → **silent**, and much worse. Chapters are written
  (`saveChapters` doesn't filter), but every read filters `provider.enabled = true`, so nothing
  shows up in the app — and on the next run `syncWithDatabase` reads `enabled = false` and turns
  the scraper off. A provider that scraped once, wrote into the void, then switched itself off.

Auto-creation can't know the `type` either — it only ever receives a name and a URL. So insert
the row explicitly, **before the first run that scrapes the site**:

```sql
insert into providers (name, base_url, type, enabled)
select 'Rokari Comics', 'https://rokaricomics.com', 'manhwa', true
where not exists (select 1 from providers where name = 'Rokari Comics');
```

No `ON CONFLICT`, deliberately: that would require a UNIQUE index on `name`, and uniqueness here
is a convention of the code (`.eq("name", …).single()`), not necessarily of the schema. If a run
got there first, the row exists untyped — catch it up with
`update providers set type = 'manhwa', enabled = true where name = 'Rokari Comics';`.

Two things a new site will need from the caller: the series title often differs per site
(*Aching* / *Heart-Aching* / *Lingering Pain* — same series), so `titleSynonyms` does the real
work; and the slug is not derivable from the title, so always go through the site's search.

## Adding or removing a provider

For a site that needs its own logic (an API, a JS-rendered page, a bespoke theme), everything
happens **here**, in a single commit:

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

### The `type` field decides whether a provider is ever called

`type` is not a label. `orderScrapersForType` **drops** sources whose type doesn't match the
series — it doesn't merely rank them last:

- `'multiple'` → tried on every series, and moved to the **front** of the queue (`unshift`).
- `'manga'` / `'manhwa'` → tried **only** on series of that type. `manhua` normalises to `manhwa`.

So a source declared `'manga'` is *invisible* to every manhwa in the catalogue. That was MangaDex's
situation until it moved to `'multiple'`: an API whose catalogue spans all three, gated to one.
When in doubt, `'multiple'` is the safe value — the cost of a wrong `'multiple'` is wasted scraping
time on some series, while the cost of a wrong `'manga'` is a source that silently never runs.

The same word lives in **two** places, and they are independent:

| Where | Read by | Effect |
|---|---|---|
| `scraperManager.initializeScrapers()` | the cron | **decides what gets scraped** |
| `providers.type` (DB column) | `getProviders()` → `/api/providers` | **display only**, on the app's About page |

`syncWithDatabase` only ever reads `enabled` back from the database — never `type`. Changing the
column changes nothing about scraping, and changing the code changes nothing about the page. Change
one and the other goes quietly stale, so change both:

```sql
update providers set type = 'multiple'
 where name = 'MangaDex' and type is distinct from 'multiple';
```

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

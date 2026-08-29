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
│   └── simpleCache.ts        in-memory TTL cache
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

> Code comments are in **French**, matching the rest of the ManTrack codebase.

## Configuration

Three secrets, set under **Settings → Secrets and variables → Actions**:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (public reads) |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔴 Service-role key — writes, bypasses RLS. Never client-side. |

Two optional cron knobs, via environment variables: `CRON_CONCURRENCY` (default `4`, mangas
processed in parallel) and `CRON_BATCH_DELAY` (default `300` ms, pause after each manga to stay
polite with upstream sources).

Locally, a gitignored `.env` is enough:

```bash
npm install
npm run cron:update-chapters   # runs the real job — writes to the database
npm run typecheck
```

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

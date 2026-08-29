# mantrack-chapters

Couche **« chapitres »** de [ManTrack](https://mantrack.vercel.app) : les 6 scrapers de
sites de scans, leur orchestrateur, le service qui écrit les chapitres en base, et le
**cron GitHub Actions** qui rafraîchit tout ça toutes les 2 heures.

Ce dépôt est à la fois :

- **un package** (`@mantrack/chapters`) consommé par l'application ManTrack (dépôt privé) ;
- **un job planifié** autonome, qui tourne ici et écrit directement dans Supabase.

> ⚠️ **Ne contient aucune métadonnée de série.** Les titres, synopsis, scores et genres
> viennent de l'API Jikan / MyAnimeList et vivent côté application (`localMangaService`).
> Ici, on ne s'occupe que des **chapitres**. Deux couches distinctes, à ne pas confondre.

## Pourquoi ce dépôt est séparé (et public)

Le cron consomme **~11 min par exécution × 12 par jour ≈ 3 400 min/mois** de GitHub
Actions. Le plan gratuit d'un dépôt **privé** plafonne à 2 000 min/mois, et le
dépassement **bloque tous les workflows du dépôt**. Les minutes ne sont illimitées que
sur un dépôt **public**.

D'où la séparation : l'application (UI, back-office, logique métier) reste **privée**,
et seule cette couche scraping — qui n'a rien de confidentiel — vit ici, en public, où
le cron peut tourner sans quota.

Aucun secret n'est versionné : les clés Supabase vivent dans les *GitHub Secrets* de ce
dépôt (voir §Configuration).

## Ce qu'il y a dedans

```
src/
├── index.ts                  point d'entrée du package (ce que l'app importe)
├── types.ts                  Provider, Chapter, ChapterWithProvider, ScrapedChapter…
├── chapterService.ts         lecture/écriture des chapitres en base
├── lib/
│   ├── supabase.ts           client anon (données publiques)
│   ├── supabaseAdmin.ts      client service-role — SERVEUR UNIQUEMENT
│   └── simpleCache.ts        cache mémoire (TTL)
├── scrapers/
│   ├── types.ts              interface `MangaScraper` — le contrat d'un provider
│   ├── scraperManager.ts     orchestrateur : sélection, parallélisme, activation
│   ├── asuraComicScraper.ts
│   ├── mangadexScraper.ts
│   ├── mangaParkScraper.ts
│   ├── mangaPillScraper.ts
│   ├── weebCentralScraper.ts
│   └── mangaKatanaScraper.ts
└── cron/
    └── update-chapters.ts    le job planifié (entrée du workflow)
```

## Configuration

Trois secrets, à définir dans **Settings → Secrets and variables → Actions** :

| Variable | Rôle |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL du projet Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clé anon (lectures publiques) |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔴 Clé service-role — écritures, bypass RLS. Jamais côté client. |

Deux réglages optionnels du cron, via variables d'environnement :
`CRON_CONCURRENCY` (défaut `4`, mangas traités en parallèle) et `CRON_BATCH_DELAY`
(défaut `300` ms, pause après chaque manga pour rester poli avec les sources).

En local, un `.env` (gitignoré) suffit :

```bash
npm install
npm run cron:update-chapters   # exécute le job pour de vrai — écrit en base
npm run typecheck
```

## Ajouter ou retirer un provider

Tout se passe **ici**, en un seul commit :

1. Créer `src/scrapers/monScraper.ts` qui implémente `MangaScraper` (`src/scrapers/types.ts`).
2. L'enregistrer dans `src/scrapers/scraperManager.ts` (import + entrée de configuration).
3. L'exporter depuis `src/scrapers/index.ts` et, si besoin, `src/index.ts`.
4. `npm run typecheck`, puis commit sur `main`.

**Côté cron : c'est actif à l'exécution suivante**, rien d'autre à faire.

**Côté application** : l'app épingle un commit de ce dépôt dans son `package-lock.json`.
Pour qu'elle voie le nouveau provider (notamment dans `/admin/providers`), y lancer :

```bash
npm update @mantrack/chapters && git commit -am "⬆️ deps : nouveau provider" && git push
```

Le déploiement Vercel suivant l'embarque.

## Versions figées

`cheerio`, `got-scraping` et `@supabase/supabase-js` sont épinglés en version **exacte**,
volontairement : le cron doit scraper avec exactement les mêmes bibliothèques que la
production. `cheerio@1.2.0`, par exemple, casse déjà la compilation (le type `Cheerio`
y devient générique). Toute montée de version se fait ici, puis se propage à l'app.

## Le package, côté application

Le package est distribué en **source TypeScript**, sans étape de build : le cron
l'exécute via `tsx`, l'application le compile via `transpilePackages` — donc exactement
la même chaîne SWC qu'avant l'extraction. C'est aussi ce qui préserve l'import dynamique
de `got-scraping` (ESM-only), qu'une compilation CommonJS transformerait en `require()`
et casserait au runtime.

```ts
import { chapterService, scraperManager, type ChapterWithProvider } from "@mantrack/chapters";
```

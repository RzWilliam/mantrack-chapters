-- Activité de chaque série : date du dernier chapitre VU, par manga.
--
-- Sert la cadence adaptative du cron (cf. src/lib/refreshTiers.ts) : une série qui
-- n'a rien publié depuis des mois n'a pas besoin d'être rescrapée toutes les 2 h.
--
-- ⚠️ `max(created_at)` et non `max(release_date)` : `created_at` est la date à
-- laquelle NOUS avons vu le chapitre pour la première fois. Toujours présente,
-- jamais dépendante du format d'une source, et elle bouge dès qu'un chapitre
-- nouveau arrive — donc le palier d'une série qui reprend se réinitialise seul.
-- `release_date` vient des sources : parfois nulle, parfois fantaisiste.
--
-- ⚠️ Tant que cette fonction n'existe pas, le cron retombe sur
-- `get_chapters_unique_manga_ids` et traite TOUT au palier le plus fréquent —
-- c'est-à-dire exactement comme avant. Le déploiement peut donc se faire dans
-- l'ordre qu'on veut.
--
-- ⚠️ La réponse est tronquée à 1000 lignes par PostgREST : l'appelant DOIT paginer
-- (`.range()`), d'où le `order by manga_id` qui rend l'offset déterministe.

create or replace function get_chapters_manga_activity()
returns table (manga_id bigint, last_chapter_at timestamptz)
language sql
stable
as $$
  select
    c.manga_id::bigint,
    max(c.created_at)::timestamptz as last_chapter_at
  from chapters c
  group by c.manga_id
  order by 1;
$$;

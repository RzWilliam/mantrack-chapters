/**
 * Cadence de rafraîchissement adaptative.
 *
 * ⚠️ Raison d'être : le cron rafraîchissait TOUTE série non terminée toutes les 2 h,
 * qu'elle publie un chapitre par semaine ou qu'elle n'ait rien sorti depuis un an.
 * Le catalogue est massivement composé de la seconde catégorie : c'est le plus gros
 * levier sur la durée d'un run, et il ne coûte aucune fraîcheur là où ça compte.
 *
 * 🔴 Deux garde-fous délibérés :
 *   1. Le palier le plus lent est plafonné à 24 h, pas à une semaine. Une série
 *      dormante qui reprend doit être vue le jour même, pas le mois suivant.
 *   2. Une série dont on ignore la date du dernier chapitre (`null`) retombe sur le
 *      palier LE PLUS FRÉQUENT. C'est ce qui rend le déploiement sans risque : tant
 *      que la RPC `get_chapters_manga_activity` n'existe pas en base, tout vaut
 *      `null` et le comportement est exactement celui d'avant.
 *
 * Le palier se réinitialise tout seul : `last_chapter_at` est la date du dernier
 * chapitre VU, donc un nouveau chapitre fait repasser la série en « active ».
 */
export interface RefreshTier {
  label: string;
  /** Ancienneté max du dernier chapitre pour appartenir à ce palier. `null` = fourre-tout. */
  maxAgeDays: number | null;
  /** Intervalle minimal entre deux rafraîchissements pour ce palier. */
  intervalHours: number;
}

/** Paliers par défaut, du plus frais au plus dormant. Surchargeables via `CRON_TIERS`. */
export const DEFAULT_TIERS: RefreshTier[] = [
  { label: "active", maxAgeDays: 7, intervalHours: 2 },
  { label: "slow", maxAgeDays: 30, intervalHours: 6 },
  { label: "dormant", maxAgeDays: null, intervalHours: 24 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Palier d'une série d'après la date de son dernier chapitre.
 * `lastChapterAt === null` ⇒ palier le plus fréquent (cf. garde-fou 2 ci-dessus).
 */
export function tierFor(
  lastChapterAt: string | null,
  tiers: RefreshTier[] = DEFAULT_TIERS,
  now: number = Date.now()
): RefreshTier {
  const fallback = tiers[0];
  if (!lastChapterAt) return fallback;

  const at = Date.parse(lastChapterAt);
  // Date illisible : on ne ralentit pas une série sur une donnée qu'on ne comprend pas.
  if (Number.isNaN(at)) return fallback;

  const ageDays = (now - at) / DAY_MS;
  for (const tier of tiers) {
    if (tier.maxAgeDays === null || ageDays <= tier.maxAgeDays) return tier;
  }
  return tiers[tiers.length - 1] ?? fallback;
}

/**
 * Parse une surcharge `CRON_TIERS` de la forme `7:2,30:6,*:24`
 * (ancienneté en jours : intervalle en heures ; `*` = fourre-tout, obligatoire en fin).
 * Toute chaîne invalide renvoie `null` — l'appelant garde les paliers par défaut
 * plutôt que de tourner avec une cadence à moitié comprise.
 */
export function parseTiers(spec: string | undefined): RefreshTier[] | null {
  if (!spec?.trim()) return null;

  const tiers: RefreshTier[] = [];
  for (const part of spec.split(",")) {
    const [rawAge, rawInterval] = part.split(":").map((s) => s.trim());
    const intervalHours = Number(rawInterval);
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) return null;

    if (rawAge === "*") {
      tiers.push({ label: "catch-all", maxAgeDays: null, intervalHours });
      continue;
    }
    const maxAgeDays = Number(rawAge);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return null;
    tiers.push({ label: `<${maxAgeDays}d`, maxAgeDays, intervalHours });
  }

  if (tiers.length === 0) return null;
  // Le fourre-tout doit exister et être le dernier, sinon des séries n'ont pas de palier.
  if (tiers[tiers.length - 1].maxAgeDays !== null) return null;
  if (tiers.slice(0, -1).some((t) => t.maxAgeDays === null)) return null;

  return tiers;
}

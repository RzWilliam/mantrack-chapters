import type { ScrapedChapter } from "../types";

/**
 * Sélection des chapitres à réellement écrire en base.
 *
 * ⚠️ Raison d'être : `saveChapters` ré-upsertait TOUT l'historique d'une série, pour
 * chaque source, toutes les 2 h — de l'ordre de 150 lignes × 6 sources × 12 runs par
 * jour, pour typiquement zéro ou un chapitre nouveau. Chaque ligne réécrite déclenche
 * en plus le trigger `update_chapters_updated_at`.
 *
 * 🔴 Ce n'est PAS un simple « n'insérer que ce qui manque ». L'upsert intégral rendait
 * gratuitement un service qu'on ne veut pas perdre : corriger `link` et `release_date`
 * quand une source les révise. Or elle ne les révise, en pratique, que sur les
 * derniers chapitres — ceux qui viennent de sortir. D'où la fenêtre de rafraîchissement :
 * on réécrit toujours les N chapitres les plus récents de ce que la source affiche,
 * et on n'insère le reste que s'il est absent.
 */
export interface ChapterSelection {
  toUpsert: ScrapedChapter[];
  /** Chapitres déjà en base et hors fenêtre : ni lus, ni réécrits. */
  skipped: number;
}

/**
 * @param scraped - ce que la source affiche aujourd'hui
 * @param existingNumbers - numéros déjà en base pour ce couple (série, source)
 * @param refreshWindow - nombre de chapitres récents systématiquement réécrits
 */
export function selectChaptersToUpsert(
  scraped: ScrapedChapter[],
  existingNumbers: Set<number>,
  refreshWindow: number
): ChapterSelection {
  // Première visite de cette source pour cette série : tout écrire.
  if (existingNumbers.size === 0) {
    return { toUpsert: scraped, skipped: 0 };
  }

  // Seuil = le N-ième numéro le plus élevé PARMI CE QUE LA SOURCE AFFICHE. On se cale
  // sur la source et non sur la base : c'est bien la zone qu'elle est susceptible de
  // corriger. Fenêtre <= 0 ⇒ aucun rafraîchissement, on n'insère que ce qui manque.
  const descending = scraped
    .map((chapter) => chapter.chapter_number)
    .sort((a, b) => b - a);
  const threshold =
    refreshWindow > 0
      ? descending[Math.min(refreshWindow, descending.length) - 1]
      : Number.POSITIVE_INFINITY;

  const toUpsert = scraped.filter(
    (chapter) =>
      !existingNumbers.has(chapter.chapter_number) ||
      chapter.chapter_number >= threshold
  );

  return { toUpsert, skipped: scraped.length - toUpsert.length };
}

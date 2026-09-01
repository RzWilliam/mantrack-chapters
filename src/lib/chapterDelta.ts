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
 * quand une source les révise. Deux critères distincts le remplacent, et ils ne
 * couvrent pas la même chose :
 *
 *  1. **`link` est comparé ligne à ligne.** C'est ce qui répare un lien révisé sur un
 *     chapitre ANCIEN — le 7 d'une série qui en compte 100. La fenêtre seule ne le
 *     pouvait pas, et aucun réglage de la fenêtre ne le pourrait : elle est
 *     positionnelle, donc définitivement aveugle à tout ce qui sort du haut de la
 *     liste. Bonus : quand rien ne change, plus une seule écriture.
 *  2. **La fenêtre de rafraîchissement subsiste, pour `release_date` seule.** On
 *     réécrit toujours les N chapitres les plus récents de ce que la source affiche.
 *
 * 🔴 Pourquoi `release_date` n'est PAS comparée, et ne doit pas l'être : quand une
 * source affiche une date relative (« 2 days ago »), le parsing la résout contre
 * `Date.now()` — cf. `wpComicScraper.parseDate`, et le même schéma dans MangaKatana,
 * MangaPark et Asura. La valeur produite change donc à CHAQUE run. La comparer
 * marquerait ces lignes comme modifiées en permanence et ramènerait l'upsert intégral
 * — le problème qu'on croit avoir corrigé, en pire. Le selfcheck verrouille ce point.
 */
export interface ChapterSelection {
  toUpsert: ScrapedChapter[];
  /** Chapitres déjà en base, lien identique et hors fenêtre : ni réécrits, ni comptés. */
  skipped: number;
  /**
   * Chapitres réécrits UNIQUEMENT parce que leur lien avait changé, hors fenêtre.
   *
   * ⚠️ C'est une sonde, pas une statistique : une source qui se mettrait à produire
   * des URL instables (paramètre variable, jeton, ordre de query string) ferait
   * grimper ce compteur run après run sur les mêmes séries. C'est le seul mode de
   * panne de la comparaison de liens, et c'est ainsi qu'il se voit.
   */
  relinked: number;
}

/**
 * @param scraped - ce que la source affiche aujourd'hui
 * @param existing - lien déjà stocké, par numéro, pour ce couple (série, source)
 * @param refreshWindow - nombre de chapitres récents systématiquement réécrits
 */
export function selectChaptersToUpsert(
  scraped: ScrapedChapter[],
  existing: Map<number, string | null>,
  refreshWindow: number
): ChapterSelection {
  // Première visite de cette source pour cette série : tout écrire.
  if (existing.size === 0) {
    return { toUpsert: scraped, skipped: 0, relinked: 0 };
  }

  // Seuil = le N-ième numéro le plus élevé PARMI CE QUE LA SOURCE AFFICHE. On se cale
  // sur la source et non sur la base : c'est bien la zone qu'elle est susceptible de
  // corriger. Fenêtre <= 0 ⇒ aucun rafraîchissement de date, la comparaison de liens
  // continue de faire son travail.
  const descending = scraped
    .map((chapter) => chapter.chapter_number)
    .sort((a, b) => b - a);
  const threshold =
    refreshWindow > 0
      ? descending[Math.min(refreshWindow, descending.length) - 1]
      : Number.POSITIVE_INFINITY;

  const toUpsert: ScrapedChapter[] = [];
  let relinked = 0;

  for (const chapter of scraped) {
    const known = existing.has(chapter.chapter_number);
    const inWindow = chapter.chapter_number >= threshold;
    // ⚠️ `!==` sur le lien couvre aussi le cas d'un `link` nul en base : la ligne est
    // alors complétée, ce que l'ancien filtre par numéro ne faisait jamais.
    const linkChanged =
      known && existing.get(chapter.chapter_number) !== chapter.link;

    if (!known || inWindow || linkChanged) {
      toUpsert.push(chapter);
      // Hors fenêtre uniquement : dans la fenêtre la ligne serait réécrite de toute
      // façon, l'y compter noierait la sonde sous le bruit normal.
      if (linkChanged && !inWindow) relinked++;
    }
  }

  return { toUpsert, skipped: scraped.length - toUpsert.length, relinked };
}

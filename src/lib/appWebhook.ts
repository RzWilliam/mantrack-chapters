/**
 * Notification de fin de run vers l'application ManTrack.
 *
 * ⚠️ Ce dépôt est PUBLIC et ne doit rien savoir des lecteurs. Le contrat est donc
 * volontairement famélique : on envoie une liste de `mal_id` — les séries pour
 * lesquelles au moins une ligne `chapters` a été écrite pendant ce run — et RIEN
 * d'autre. Ni titre, ni numéro de chapitre, ni le moindre identifiant utilisateur.
 * L'application (dépôt privé) recalcule le diff depuis la base et décide seule à
 * qui envoyer une push. Toute tentation d'enrichir ce payload est une fuite de
 * données produit dans un dépôt que n'importe qui peut lire.
 *
 * ⚠️ Ce webhook est un CONFORT, jamais une condition de succès du run : les
 * chapitres sont déjà en base quand on l'appelle. Un échec produit une annotation
 * `::warning::` et s'arrête là (cf. `notifyApp`).
 */

/**
 * Budget de la requête, en millisecondes.
 *
 * ⚠️ Même règle que `src/lib/http.ts` : `fetch` n'a AUCUN timeout par défaut.
 * Ici le risque n'est pas un worker bloqué mais le job entier suspendu jusqu'au
 * `timeout-minutes: 60` — après que tout le travail utile a été fait, et donc
 * pour rien. 10 s est large devant un POST qui ne fait qu'accuser réception.
 */
export const WEBHOOK_TIMEOUT_MS =
  Number(process.env.APP_WEBHOOK_TIMEOUT_MS) || 10_000;

/**
 * Ids par requête. Même raison que les `.in()` du cron : une URL/un corps qui
 * grandit avec le catalogue finit par se heurter à une limite (proxy, body size)
 * — et ce serait au pire moment, un run qui a beaucoup produit.
 */
export const WEBHOOK_BATCH_SIZE = 500;

/** Ce qu'a donné l'appel, pour le bilan de run. */
export interface WebhookOutcome {
  /** `skipped` = pas d'appel du tout ; `partial` = au moins un lot passé, pas tous. */
  status: "sent" | "partial" | "failed" | "skipped";
  /** Ids retenus par ce run (0 si rien n'a été écrit). */
  ids: number;
  /** Ids effectivement acceptés par l'application. */
  sentIds: number;
  /** Lots tentés / lots acceptés. */
  batches: number;
  sentBatches: number;
  /** Motif du saut ou de l'échec. Jamais l'URL (cf. `describeError`). */
  reason?: string;
}

/** Une ligne de résultat du cron, réduite à ce dont le webhook a besoin. */
export interface NotifiableResult {
  manga_id: number;
  success: boolean;
  chapters_found?: number;
}

/**
 * Séries à signaler : celles dont ce run a réellement écrit au moins un chapitre.
 *
 * ⚠️ Le critère est `chapters_found > 0`, PAS `success`. Une série traitée sans
 * nouveauté (le cas de très loin le plus fréquent — la plupart des runs ne
 * trouvent rien de neuf sur la plupart des séries) réveillerait l'application
 * pour un diff vide, 48 fois par jour et pour tout le catalogue.
 *
 * Dédoublonné et trié : le cron produit une ligne par série, mais un payload
 * stable se relit et se compare, et l'appelant n'a pas à connaître cette garantie.
 */
export function collectNotifiableMalIds(results: NotifiableResult[]): number[] {
  const ids = new Set<number>();
  for (const r of results) {
    if (!r.success) continue;
    if (!r.chapters_found || r.chapters_found <= 0) continue;
    ids.add(r.manga_id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** Découpe en lots d'au plus `size` éléments. */
export function chunkIds(ids: number[], size = WEBHOOK_BATCH_SIZE): number[][] {
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    batches.push(ids.slice(i, i + size));
  }
  return batches;
}

/**
 * Décrit une erreur SANS jamais recracher l'URL appelée.
 *
 * ⚠️ Les logs de ce dépôt sont publics. GitHub masque les secrets qu'il connaît,
 * mais un `TypeError: fetch failed to https://…` en exécution locale, ou un
 * fragment d'URL recomposé, ne bénéficie d'aucun masquage. On ne garde donc que
 * le type de la panne, jamais la cible.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "request failed";

  // `AbortSignal.timeout` rejette avec une `TimeoutError`.
  if (error.name === "TimeoutError") {
    return `timed out after ${WEBHOOK_TIMEOUT_MS}ms`;
  }

  // Un échec réseau d'undici est un `TypeError: fetch failed` — un nom qui
  // n'apprend rien. Le vrai motif est dans `cause.code` (ECONNREFUSED, ENOTFOUND,
  // CERT_HAS_EXPIRED…) : un code court, sans URL, qui dit quoi aller regarder.
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && code) return code;

  return error.name || "request failed";
}

/**
 * Signale à l'application les séries dont ce run a écrit des chapitres.
 *
 * Ne throw JAMAIS : tous les chemins d'erreur reviennent par le `WebhookOutcome`.
 * Les deux variables d'environnement manquantes ⇒ saut SILENCIEUX (pas d'alerte) :
 * ce script doit rester exécutable tel quel sur un fork ou en local, où ce webhook
 * n'a aucun sens.
 */
export async function notifyApp(malIds: number[]): Promise<WebhookOutcome> {
  const url = process.env.APP_WEBHOOK_URL?.trim();
  const secret = process.env.APP_WEBHOOK_SECRET?.trim();

  const base: WebhookOutcome = {
    status: "skipped",
    ids: malIds.length,
    sentIds: 0,
    batches: 0,
    sentBatches: 0,
  };

  if (!url || !secret) {
    return {
      ...base,
      reason: "APP_WEBHOOK_URL / APP_WEBHOOK_SECRET not set",
    };
  }

  // Rien à annoncer : un POST avec une liste vide ferait travailler l'application
  // pour un diff qu'on sait déjà vide.
  if (malIds.length === 0) {
    return { ...base, reason: "no chapter written this run" };
  }

  const batches = chunkIds(malIds);
  let sentIds = 0;
  let sentBatches = 0;
  const errors: string[] = [];

  for (const batch of batches) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ manga_ids: batch }),
        // Un signal est à usage unique : un par lot, jamais partagé.
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      if (!response.ok) {
        errors.push(`HTTP ${response.status}`);
        continue;
      }

      sentIds += batch.length;
      sentBatches++;
    } catch (error) {
      // On tente quand même les lots suivants : une coupure passagère sur l'un
      // d'eux n'a pas de raison de priver l'application de tous les autres.
      errors.push(describeError(error));
    }
  }

  if (sentBatches === batches.length) {
    return {
      status: "sent",
      ids: malIds.length,
      sentIds,
      batches: batches.length,
      sentBatches,
    };
  }

  return {
    status: sentBatches > 0 ? "partial" : "failed",
    ids: malIds.length,
    sentIds,
    batches: batches.length,
    sentBatches,
    // Motifs dédoublonnés : 3 lots en timeout n'ont pas besoin de 3 lignes.
    reason: [...new Set(errors)].join(", ") || "request failed",
  };
}

/**
 * Bloc Markdown ajouté au bilan de run, une fois l'appel terminé.
 *
 * ⚠️ C'est bien un SECOND bloc, publié après coup, et non une ligne du tableau
 * principal : le bilan et les timestamps partent AVANT le webhook, pour qu'une
 * application lente ou muette ne mette pas en péril ce qui compte. Le prix à
 * payer est cette petite section séparée ; il est dérisoire devant l'inverse.
 */
export function buildWebhookSummary(outcome: WebhookOutcome): string[] {
  const plural = (n: number) => (n === 1 ? "" : "s");
  const value = (() => {
    switch (outcome.status) {
      case "sent":
        return `${outcome.sentIds} id${plural(outcome.sentIds)} in ${
          outcome.batches
        } batch${outcome.batches > 1 ? "es" : ""}`;
      case "partial":
        return `${outcome.sentIds}/${outcome.ids} ids (${outcome.sentBatches}/${outcome.batches} batches) — ${outcome.reason}`;
      case "failed":
        return `0/${outcome.ids} ids — ${outcome.reason}`;
      case "skipped":
        return `skipped — ${outcome.reason}`;
    }
  })();

  return [
    "### 🔔 App notification",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| App webhook | ${value} |`,
    "",
    "Only `mal_id`s travel — the app recomputes the diff and decides who gets a push.",
  ];
}

/**
 * Alerte à publier si l'appel n'a pas abouti. Vide sinon — et vide aussi pour un
 * saut, qui est un mode de fonctionnement normal (fork, exécution locale).
 */
export function buildWebhookAlerts(outcome: WebhookOutcome): string[] {
  if (outcome.status === "sent" || outcome.status === "skipped") return [];
  const missed = outcome.ids - outcome.sentIds;
  return [
    `app webhook: ${outcome.sentBatches}/${outcome.batches} batches delivered (${outcome.reason}) — the app was not told about ${missed} series`,
  ];
}

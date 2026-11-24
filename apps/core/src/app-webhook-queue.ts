import { appWebhookLimits } from "@grasp-os/shared/app-webhooks";
import type { AppWebhookEvent } from "@grasp-os/shared/app-webhooks";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { jsonOf } from "@grasp-os/shared/functions";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { storeIntentSchema } from "@grasp-os/shared/stores";
import type { SubmissionIntent } from "@grasp-os/shared/submissions";
import {
  submissionRetentionDays,
  submissionTombstoneDays,
} from "@grasp-os/shared/submissions";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import type { FunctionRequest } from "./app-functions.ts";
import {
  appFormSubmissions,
  apps,
  appWebhookDeliveries,
  appWebhooks,
  personErasures,
} from "./db/core/schema.ts";
import type { OutboxEntry } from "./outbox-delivery.ts";

// Queuing an App's events for its webhooks (app-webhooks.ts has the threat
// model): from the batch of a publish or a version made current, and after
// a form's submission answered. Apart, so the App's own modules queue
// without reaching the webhooks' settings.

/**
 * How long a form's submission told, and a delivery settled, is kept:
 * past the longest a receipt answers the same submission again, and its
 * tombstone after it (submissions.ts), so a repeat is never told twice.
 */
export const formKeptMs =
  (submissionRetentionDays + submissionTombstoneDays) * 24 * 60 * 60_000;

/** That webhook `webhook` has room for another delivery waiting, as SQL. */
const roomFor = (webhook: SQL | string): SQL =>
  sql`(SELECT count(*) FROM ${appWebhookDeliveries}
    WHERE ${appWebhookDeliveries.webhookId} = ${webhook}
      AND ${appWebhookDeliveries.deliveredAt} IS NULL) < ${appWebhookLimits.waiting}`;

/** That webhook row `webhook` takes `event`, as SQL. */
const takes = (event: AppWebhookEvent): SQL =>
  sql`EXISTS (SELECT 1 FROM json_each(${appWebhooks.events}) WHERE value = ${event})`;

/**
 * Counts a delivery dropped for each webhook `which` selects that has no
 * room for it: run before the delivery is queued, so its own doesn't
 * count against it.
 */
const droppedWhere = (db: DrizzleD1Database, which: SQL) =>
  db
    .update(appWebhooks)
    .set({ dropped: sql`${appWebhooks.dropped} + 1` })
    .where(and(which, sql`NOT ${roomFor(sql`${appWebhooks.id}`)}`));

/**
 * A delivery of `event` of App `app` to each of its webhooks that takes
 * it, once per webhook under `dedupe`, queued only if `condition` holds as
 * the statements run: for the batch of the change it reports (a publish,
 * a version made current), so the change and its deliveries are kept
 * together or not at all. It carries IDs only: `version` is the one it
 * reports, or `current` for the App's current version as the statement
 * runs, so a version made current meanwhile is the one told. A webhook
 * with too many waiting counts it dropped instead.
 */
export const queuedWebhookDeliveries = (
  db: DrizzleD1Database,
  {
    app,
    event,
    dedupe,
    version = null,
  }: {
    app: string;
    event: Exclude<AppWebhookEvent, "form_sent">;
    dedupe: string;
    version?: number | "current" | null;
  },
  condition: SQL
) => {
  const reported =
    version === "current"
      ? sql`(SELECT ${apps.currentVersion} FROM ${apps} WHERE ${apps.id} = ${app})`
      : sql`${version}`;
  return [
    droppedWhere(
      db,
      sql`${appWebhooks.appId} = ${app} AND ${takes(event)} AND ${condition}`
    ),
    db
      .insert(appWebhookDeliveries)
      .select(
        sql`SELECT lower(hex(randomblob(16))), ${appWebhooks.id}, ${appWebhooks.appId}, ${event}, ${dedupe}, ${Date.now()}, ${reported}, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL
        FROM ${appWebhooks}
        WHERE ${appWebhooks.appId} = ${app}
          AND ${takes(event)}
          AND ${roomFor(sql`${appWebhooks.id}`)}
          AND ${condition}`
      )
      .onConflictDoNothing(),
  ] as const;
};

/**
 * A form a page sent, as core answered it: a keyed mutation, or a keyed
 * action, of App `app`, by `userId`, to the public function at `path`,
 * in the run that started at `startedAt` (its receipt's, its invocation's:
 * the same for every repeat of that run, new for a fresh run under the
 * key once its receipt is gone). Plain JSON, so a run's receipt or a
 * mutation's commit keeps it until its webhooks are told.
 */
const formSubmissionSchema = z.strictObject({
  app: z.string().min(1),
  userId: z.string().min(1),
  kind: z.string().min(1),
  /** The function the form called, by name. */
  name: z.string().min(1),
  /** The submission's idempotency key. */
  key: z.string().min(1),
  /** The path of the function it sent to. */
  function: z.string().min(1),
  startedAt: z.number().int().min(0),
  /** The form's values; null, and `valuesLeftOut`, past what a delivery takes. */
  values: z.custom<Json>(),
  valuesLeftOut: z.boolean(),
});
export type FormSubmission = z.infer<typeof formSubmissionSchema>;

/** The most bytes of a form's values a delivery carries: room for the rest. */
const valuesMaxBytes = appWebhookLimits.bodyBytes - 1024;

/**
 * The intent a page's keyed mutation commits with its writes (its
 * store's outbox), so its form is told once it committed, and never
 * unless it did: `dispatchFormSent` hands it over.
 */
export const formSentIntent = (
  submission: FormSubmission
): SubmissionIntent => ({ kind: "app.form_sent", data: submission });

/**
 * The intents a mutation's commit may carry for `submission`: with its
 * values, and without them, for a commit that wouldn't hold them.
 */
export const formIntents = (
  submission: FormSubmission
): { full: SubmissionIntent; lean: SubmissionIntent } => ({
  full: formSentIntent(submission),
  lean: formSentIntent({ ...submission, values: null, valuesLeftOut: true }),
});

/** `call`, sent under `key` to the function at `path` in the run started at `startedAt`, as a form. */
export const formSubmissionOf = ({
  app,
  userId,
  call,
  key,
  path,
  startedAt,
}: {
  app: string;
  userId: string;
  call: Pick<FunctionRequest, "args" | "reference">;
  key: string;
  path: string;
  startedAt: number;
}): FormSubmission => {
  // What the call took, read as JSON: none that wouldn't read is left out.
  const read = call.args === undefined ? null : jsonOf(call.args);
  const values: Json = read ?? null;
  const fits =
    read !== undefined &&
    new TextEncoder().encode(JSON.stringify(values)).byteLength <=
      valuesMaxBytes;
  const { kind, name } = call.reference;
  const submission: FormSubmission = {
    app,
    userId,
    kind,
    name,
    key,
    function: path,
    startedAt,
    values: fits ? values : null,
    valuesLeftOut: !fits,
  };
  // Kept as a store keeps an intent: values a level too deep once kept in
  // it are left out, as ones too large are, so the commit never fails on
  // its form.
  return storeIntentSchema.safeParse(formSentIntent(submission)).success
    ? submission
    : { ...submission, values: null, valuesLeftOut: true };
};

/**
 * The ID of `submission`: all of who sent it, to what, under which key and
 * in which run, so no two people, functions or runs share one through a
 * key, and every repeat of one run does.
 */
const submissionIdOf = async ({
  app,
  userId,
  kind,
  name,
  key,
  startedAt,
}: FormSubmission): Promise<string> =>
  await sha256Hex(
    canonicalJson(["form_sent", kind, userId, app, name, key, startedAt])
  );

/**
 * Queues `form_sent` for `submission`, once its run succeeded, once per
 * run: to each of its App's webhooks that takes it and was there when its
 * run started, with the form's values only for one approved by then, IDs
 * only for any other. A repeat of the run finds it told and queues
 * nothing; a webhook removed meanwhile is skipped; one with too many
 * waiting counts it dropped instead. Throws when it couldn't, for its
 * caller to try again: the run's receipt (action-invocation.ts) or the
 * mutation's outbox (`dispatchFormSent`) keeps it until it is told.
 */
export const queueFormSent = async (
  env: Env,
  submission: FormSubmission
): Promise<void> => {
  const {
    app,
    userId,
    key,
    function: path,
    startedAt,
    values,
    valuesLeftOut,
  } = submission;
  const db = drizzle(env.DB);
  // An App removed, or gone, has nobody left to tell: done, never a
  // failure to try again for as long as the run's receipt is kept.
  const live = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.id, app), isNull(apps.removedAt)))
    .get();
  if (live === undefined) {
    return;
  }
  const id = await submissionIdOf(submission);
  const webhooks = await db
    .select({ id: appWebhooks.id, approvedAt: appWebhooks.approvedAt })
    .from(appWebhooks)
    .where(
      and(
        eq(appWebhooks.appId, app),
        takes("form_sent"),
        lte(appWebhooks.createdAt, new Date(startedAt))
      )
    );
  const json = valuesLeftOut ? null : JSON.stringify(values);
  // That this batch told it: whoever tells it first, alone, by a claim
  // of its own, never a time two tells may share.
  const claim = crypto.randomUUID();
  const toldNow = sql`EXISTS (SELECT 1 FROM ${appFormSubmissions}
    WHERE ${appFormSubmissions.id} = ${id}
      AND ${appFormSubmissions.claim} = ${claim})`;
  // A form of someone erased goes nowhere: one kept untold in a run's
  // receipt or a store's outbox as their erasure was asked for is told,
  // so never again, but queued to no webhook. One queued before it is
  // taken out by the erasure (person-erasure.ts), which asks first, so
  // whichever runs first, none is left.
  const notErased = sql`NOT EXISTS (SELECT 1 FROM ${personErasures}
    WHERE ${personErasures.userId} = ${userId})`;
  await db.batch([
    db
      .insert(appFormSubmissions)
      .values({ id, appId: app, toldAt: new Date(), claim })
      .onConflictDoNothing(),
    ...webhooks.flatMap(({ id: webhook, approvedAt }) => {
      const approved = approvedAt !== null && approvedAt.getTime() <= startedAt;
      return [
        droppedWhere(
          db,
          sql`${appWebhooks.id} = ${webhook} AND ${toldNow} AND ${notErased}`
        ),
        // Only while the webhook is still there: one removed since it was
        // read is skipped, never failing the others' deliveries.
        db
          .insert(appWebhookDeliveries)
          .select(
            sql`SELECT ${crypto.randomUUID().replaceAll("-", "")}, ${appWebhooks.id}, ${app}, 'form_sent', ${`form_sent:${id}`}, ${startedAt}, NULL, ${key}, ${approved ? path : null}, ${approved ? json : null}, ${approved && valuesLeftOut ? 1 : 0}, 0, NULL, NULL, NULL, ${userId}
              FROM ${appWebhooks}
              WHERE ${appWebhooks.id} = ${webhook}
                AND ${roomFor(webhook)}
                AND ${toldNow}
                AND ${notErased}`
          )
          .onConflictDoNothing(),
      ];
    }),
  ]);
};

/**
 * Whether App `app` has a webhook a form sent in a run started at
 * `startedAt` would be told to: one that takes `form_sent` and was there
 * by then, as `queueFormSent` chooses. A form nobody would hear is
 * committed with nothing to tell, so its receipt keeps to its own time.
 * True when it can't be read: then it is committed to tell, and told to
 * whoever is there.
 */
export const formHeardBy = async (
  env: Env,
  app: string,
  startedAt: number
): Promise<boolean> => {
  try {
    const found = await drizzle(env.DB)
      .select({ id: appWebhooks.id })
      .from(appWebhooks)
      .where(
        and(
          eq(appWebhooks.appId, app),
          takes("form_sent"),
          lte(appWebhooks.createdAt, new Date(startedAt))
        )
      )
      .limit(1)
      .get();
    return found !== undefined;
  } catch (error) {
    log.warn("app.webhook.listeners_unread", { app, ...errorFields(error) });
    return true;
  }
};

/**
 * Hands a committed mutation's form over to its App's webhooks
 * (`queueFormSent`): thrown, and so tried again by its outbox, when it
 * couldn't; once per run whatever the outbox repeats.
 */
export const dispatchFormSent = async (
  env: Env,
  entry: Pick<OutboxEntry, "id" | "intent">
): Promise<"delivered" | { undeliverable: string }> => {
  const read =
    entry.intent.kind === "app.form_sent"
      ? formSubmissionSchema.safeParse(entry.intent.data)
      : undefined;
  if (read?.success !== true) {
    log.error("app.webhook.form_unreadable", { entry: entry.id });
    return { undeliverable: "outbox.unreadable" };
  }
  await queueFormSent(env, read.data);
  return "delivered";
};

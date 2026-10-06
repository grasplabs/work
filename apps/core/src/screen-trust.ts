import { actorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import { artifactSchema } from "@grasp-os/shared/screen-trust";
import type {
  ArtifactTrust,
  OutputClass,
  ScreenDelivery,
} from "@grasp-os/shared/screen-trust";
import { screenErrors } from "@grasp-os/shared/screens";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import {
  auditOutbox,
  permissions,
  screenArtifacts,
  screenPolicies,
} from "./db/core/schema.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { appHost } from "./durable-objects.ts";

// Whether a screen gets its App's data: the one gate every way from an
// App to a screen passes (screens-rpc.ts), and the records it reads.
//
// A screen is code nobody reviewed line by line, in the person's browser.
// The frame it runs in has no network by the browser's own rules, but
// those don't close every channel: in two of three browsers a frame still
// got a packet out to a TURN server, and nothing the page sets stops it
// (security-headers.ts says what was measured). So what keeps an App's data
// from code that would send it away is not the frame but this: core hands
// the data only to code a person approved, exactly as built.
//
// Two records decide, both core's own (`screen_artifacts`,
// `screen_policies`), read from the database on every call and every
// push, never kept between them:
//
// - What the App's data is to its screens (`output`): `sensitive` until
//   an admin says `ordinary`, which is them accepting that it goes to
//   code nobody approved. They say it of the App as it is: a permission
//   granted to it later makes it `sensitive` again in the grant's batch
//   (`sensitiveAgain`).
// - What an admin decided about the exact build (`artifact`, the hash of
//   the code a frame runs): `approved`, `revoked`, or nothing yet. A
//   revoked build gets nothing, however the data is classified.
//
// What could go wrong, and what stops it:
//
// - A screen saying it is approved, or naming another build's hash.
//   Nothing a screen or the page reports is read as trust. Which build a
//   connection's frame runs is what core itself handed that person for
//   that App, proved by a lease only core can sign (`leaseFor`); whether
//   that build is approved is the row.
// - A lease used by someone else, or for another App. It is signed over
//   the person, the App and the build, and checked against the session.
// - Approval outliving the code. The hash covers the screen's modules,
//   the kit's modules it loads and its CSS: other source, another package
//   or a new release's kit is another hash, with no row. A build kept in
//   the cache is only bytes; it carries no approval.
// - Approved code running other code: HTML from the App's server that
//   the screen renders, a module from a string, eval. The frame's
//   document runs its build's modules and nothing else, by its own policy
//   (screen-frame.ts), so what was approved is what runs.
// - Approval taken back while a call runs. Trust is read before the App
//   is called and again before its answer or its error is handed over
//   (an error carries the App's own message), and before every push: a
//   revocation that committed stops the next of them.
// - Someone demoted, Grasp staff, an agent or App code approving. Only
//   one of the organization's own admins, from their own session, and
//   that they still are one is part of the write (screen-trust-rpc.ts).
//
// What this does not do. Approved code that gets the data can still send
// it away through the channels a browser leaves open: approval says a
// person trusts this code, not that nothing can leave. And what a browser
// was handed before a revocation is not taken back: the page empties the
// frame when it hears of it, at its next call or within its next check.
// The page is trusted to give back the lease of the build its frame
// runs: someone who changes their own page can present an approved
// build's lease and run other code, with data they may read anyway. And a
// release whose kit a screen loads changes that screen's hash, so its
// approval doesn't carry over: carrying it over would take a review of
// the kit that comes with the release, which nothing records yet.

/** What the lease's key is for: no other MAC of core's passes for one. */
const leasePurpose = "grasp-os screen lease";

const encoder = new TextEncoder();

/** What a lease signs: who was handed which build of which App. */
const leased = (userId: string, app: AppId, artifact: string): Uint8Array =>
  encoder.encode(canonicalJson([userId, app, artifact]));

/**
 * Core's word that it handed `artifact` of `app` to `userId`: the build's
 * hash and a MAC only core can make (a key derived from its auth secret).
 * The page gives it back on its frame's connection (`ScreensApi.present`);
 * it says which build, never that the build is approved.
 */
export const leaseFor = async (
  env: Env,
  userId: string,
  app: AppId,
  artifact: string
): Promise<string> => {
  const key = await derivedHmacKey(env, leasePurpose, ["sign", "verify"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    leased(userId, app, artifact)
  );
  return `${artifact}.${toBase64Url(new Uint8Array(mac))}`;
};

/** The longest a lease is: a hash, a dot and a MAC. */
const leaseMaxLength = 128;

/**
 * The build `lease` says core handed `userId` for `app`, or `undefined`
 * for anything core didn't sign for exactly them and that App.
 */
export const leasedArtifact = async (
  env: Env,
  userId: string,
  app: AppId,
  lease: unknown
): Promise<string | undefined> => {
  if (typeof lease !== "string" || lease.length > leaseMaxLength) {
    return undefined;
  }
  const [artifact, mac, ...more] = lease.split(".");
  if (
    mac === undefined ||
    more.length > 0 ||
    !artifactSchema.safeParse(artifact).success ||
    artifact === undefined
  ) {
    return undefined;
  }
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64Url(mac);
  } catch {
    return undefined;
  }
  const key = await derivedHmacKey(env, leasePurpose, ["sign", "verify"]);
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    leased(userId, app, artifact)
  );
  return signed ? artifact : undefined;
};

/** The App's policy generation now, as SQL: 0 until anything changed it. */
export const generationSql = (app: AppId): SQL =>
  sql`coalesce((SELECT ${screenPolicies.generation} FROM ${screenPolicies} WHERE ${screenPolicies.appId} = ${app}), 0)`;

/**
 * Moves the App's policy generation on by one if `condition` holds as the
 * statement runs, for the batch of the change it belongs to.
 */
export const advanceGeneration = (
  db: DrizzleD1Database,
  app: AppId,
  condition: SQL
) =>
  db
    .insert(screenPolicies)
    // The table's columns, in its order.
    .select(sql`SELECT ${app}, 'sensitive', 1 WHERE ${condition}`)
    .onConflictDoUpdate({
      target: screenPolicies.appId,
      set: { generation: sql`${screenPolicies.generation} + 1` },
    });

/**
 * The Apps whose reach a grant to `grantee` widens, as a recursive SQL
 * table `reaching(app_id)`: the grantee, and every App that reaches an
 * App in it through an active permission on its exports or workflows,
 * however many Apps away.
 */
const reachingSql = (grantee: AppId): SQL => sql`reaching(app_id) AS (
  SELECT ${grantee}
  UNION
  SELECT ${permissions.subjectId} FROM ${permissions}
    JOIN reaching ON ${permissions.objectId} = reaching.app_id
  WHERE ${permissions.subjectType} = 'app'
    AND ${permissions.status} = 'active'
    AND ${permissions.objectType} IN ('app', 'workflow')
)`;

/** A random version 4 UUID, as SQL, for each row it is read in. */
const uuidSql = sql`lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) ||
  '-' || hex(randomblob(6))
)`;

/**
 * What a grant to `grantee` changes for the screens of every App whose
 * reach it widens (`reachingSql`), when `condition` (that the grant
 * landed) holds as the statements run, for the grant's batch:
 *
 * - Data an admin had classified `ordinary` is `sensitive` again: they
 *   judged the data of an App with the access it had then. Recorded per
 *   App as a classification by whoever granted, with why (`because`).
 * - The policy generation of each of those Apps moves on, `sensitive` or
 *   not, so no approval or classification an admin reviewed before the
 *   grant lands after it.
 */
export const widenedByGrant = (
  db: DrizzleD1Database,
  by: Pick<Identity, "userId" | "staff">,
  grantee: AppId,
  condition: SQL,
  because: Record<string, AuditDetailValue>
): BatchItem<"sqlite">[] => {
  const now = new Date();
  const reaching = sql`WITH RECURSIVE ${reachingSql(grantee)}`;
  const reached = sql`(${reaching} SELECT app_id FROM reaching)`;
  const ordinary = sql`${screenPolicies.output} = 'ordinary'
    AND ${screenPolicies.appId} IN ${reached}
    AND ${condition}`;
  const detail = JSON.stringify({
    output: "sensitive",
    previous: "ordinary",
    grantedTo: grantee,
    ...because,
  });
  return [
    // Each event's ID is made once, then read twice.
    db.insert(auditOutbox).select(sql`${reaching},
      flipped AS MATERIALIZED (
        SELECT ${uuidSql} AS id, ${screenPolicies.appId} AS app_id
        FROM ${screenPolicies} WHERE ${ordinary}
      )
      SELECT id, json_object(
        'id', id,
        'at', ${now.toISOString()},
        'source', 'core',
        'actor', json(${JSON.stringify(actorOf(by))}),
        'action', 'app.output.classified',
        'target', json_object('type', 'app', 'id', app_id),
        'provenance', json('[]'),
        'detail', json(${detail})
      ), ${now.getTime()}
      FROM flipped`),
    db.update(screenPolicies).set({ output: "sensitive" }).where(ordinary),
    db
      .insert(screenPolicies)
      // The table's columns, in its order.
      .select(
        sql`${reaching} SELECT app_id, 'sensitive', 1 FROM reaching WHERE ${condition}`
      )
      .onConflictDoUpdate({
        target: screenPolicies.appId,
        set: { generation: sql`${screenPolicies.generation} + 1` },
      }),
  ];
};

/** What core holds for one build of an App's screen, read in one statement. */
export interface Standing {
  output: OutputClass;
  generation: number;
  trust: ArtifactTrust;
}

/**
 * What core holds now for `artifact` of `app`; a build it has no row for,
 * or none at all (a connection that presented no lease), is `unreviewed`.
 */
export const standingOf = async (
  env: Env,
  app: AppId,
  artifact?: string
): Promise<Standing> => {
  const row = await drizzle(env.DB).get<{
    output: OutputClass | null;
    generation: number;
    trust: ArtifactTrust | null;
  }>(
    sql`SELECT
      (SELECT ${screenPolicies.output} FROM ${screenPolicies} WHERE ${screenPolicies.appId} = ${app}) AS output,
      ${generationSql(app)} AS generation,
      (SELECT ${screenArtifacts.status} FROM ${screenArtifacts}
        WHERE ${screenArtifacts.appId} = ${app}
          AND ${screenArtifacts.artifact} = ${artifact ?? null}) AS trust`
  );
  return {
    output: row.output ?? "sensitive",
    generation: row.generation,
    trust: row.trust ?? "unreviewed",
  };
};

/**
 * Whether a build with that standing gets its App's data: never once its
 * approval was taken back, whatever the App's data is classified as;
 * otherwise always when an admin classified the data `ordinary`, and
 * only once approved when it is `sensitive`.
 */
export const deliveryOf = ({ output, trust }: Standing): ScreenDelivery => {
  if (trust === "revoked") {
    return "revoked";
  }
  return output === "ordinary" || trust === "approved" ? "open" : "unreviewed";
};

/** Where a screen was refused: what it asked, and at which check. */
export interface Refused {
  /** `open`, `call`, `runs`, …: the call of `ScreensApi`. */
  operation: string;
  /**
   * `admission` before anything ran, `delivery` before an answer (or an
   * error) was handed over, `push` before the App's push through a
   * callback.
   */
  stage: "admission" | "delivery" | "push";
}

/**
 * Records that `by`'s screen was refused its App's data. Identifiers
 * only: never what was asked for. The same refusal (who, which build,
 * why, what and where) is recorded once a window (the App's host
 * remembers when, once the row is written), so a screen opened again and
 * again, or a page that keeps retrying, adds no row per try.
 */
const recordRefusal = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  artifact: string | undefined,
  { generation, ...standing }: Standing,
  { operation, stage }: Refused
): Promise<void> => {
  const reason = deliveryOf({ generation, ...standing });
  const refusal = canonicalJson([
    by.userId,
    artifact ?? null,
    reason,
    operation,
    stage,
  ]);
  const host = appHost(env, app);
  if (await host.refusalAudited(refusal)) {
    return;
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: actorOf(by),
      action: "app.artifact.refused",
      target: { type: "app", id: app },
      detail: {
        artifact: artifact ?? null,
        reason,
        operation,
        stage,
        generation,
      },
    }),
  ]);
  await host.noteRefusal(refusal);
};

/**
 * Whether `artifact` of `app` gets the App's data now, for a push: a
 * refusal is recorded, and answers false.
 */
export const deliveryOpen = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  artifact: string | undefined,
  at: Refused
): Promise<boolean> => {
  const standing = await standingOf(env, app, artifact);
  if (deliveryOf(standing) === "open") {
    return true;
  }
  await recordRefusal(env, by, app, artifact, standing, at);
  return false;
};

/**
 * Refuses, with `screen.unreviewed` or `screen.revoked`, unless `artifact`
 * of `app` gets the App's data now. The refusal is recorded first.
 */
export const requireDelivery = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  artifact: string | undefined,
  at: Refused
): Promise<void> => {
  const standing = await standingOf(env, app, artifact);
  const delivery = deliveryOf(standing);
  if (delivery === "open") {
    return;
  }
  await recordRefusal(env, by, app, artifact, standing, at);
  throw screenErrors.create(
    delivery === "revoked" ? "screen.revoked" : "screen.unreviewed"
  );
};

/**
 * `run`'s answer for a screen running `artifact` of `app`: trust is read
 * before `run`, so code nobody approved starts nothing, and again before
 * whatever `run` ends with is handed over, its answer or its error, so an
 * approval taken back while it ran keeps both here. An error counts: the
 * App's own message travels in it (`app.failed`), and can hold what it
 * read. What `run` already changed stays changed.
 */
export const delivering = async <Answer>(
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  artifact: string | undefined,
  operation: string,
  run: () => Promise<Answer>
): Promise<Answer> => {
  const before: Refused = { operation, stage: "admission" };
  const after: Refused = { operation, stage: "delivery" };
  await requireDelivery(env, by, app, artifact, before);
  let answer: Answer;
  try {
    answer = await run();
  } catch (error) {
    // Refused now: the refusal goes to the screen in place of the error.
    await requireDelivery(env, by, app, artifact, after);
    throw error;
  }
  await requireDelivery(env, by, app, artifact, after);
  return answer;
};

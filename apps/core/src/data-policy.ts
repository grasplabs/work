import { actorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import type { DataPolicy, OutputClass } from "@grasp-os/shared/data-policy";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { revocationsOf } from "./access-revocations.ts";
import { apps, auditOutbox, pagePolicies } from "./db/core/schema.ts";

// What an App's data is to code Grasp didn't serve (@grasp-os/shared/
// data-policy): a portable host, with an App token, running code with all
// the network its browser or app gives it. Its calls carry no lease core
// signed, so the gate (page-delivery.ts) hands them the App's data only
// once an admin classified it `ordinary` (data-policy-rpc.ts). An App's
// own pages, which core serves into a sandboxed frame, get it whatever
// this says.
//
// An admin classifies the App as it is: a permission granted to it later,
// or to a workflow it reaches, makes its data `sensitive` again in the
// grant's batch (`widenedByGrant`), and every classification and grant
// moves the App's policy generation on, so a classification read before
// either lands after neither.

/** The App's policy generation now, as SQL: 0 until anything changed it. */
export const generationSql = (app: AppId): SQL =>
  sql`coalesce((SELECT ${pagePolicies.generation} FROM ${pagePolicies} WHERE ${pagePolicies.appId} = ${app}), 0)`;

/** Who a grant widening Apps' reach was given to: an App or a workflow. */
export type Grantee =
  | { type: "app"; appId: AppId }
  | { type: "workflow"; workflowId: string };

/**
 * The Apps whose reach a grant to `grantee` widens, as recursive SQL
 * tables ending in `reaching(app_id)`: everything that reaches the
 * grantee, however many steps away, through what lets it use another's
 * reach (`reached(kind, id)`, Apps and workflows alike):
 *
 * - an App or a workflow holding an active `start` grant on a workflow
 *   reaches that workflow, and so does a live workflow any of whose
 *   versions binds it: what it reads comes back to what started it.
 *
 * So more for a workflow reaches the Apps starting it, or starting one
 * that runs it.
 */
const reachingSql = (grantee: Grantee): SQL => {
  const seed =
    grantee.type === "app"
      ? sql`SELECT 'app', ${grantee.appId}`
      : sql`SELECT 'workflow', ${grantee.workflowId}`;
  return sql`reached(kind, id) AS (
  ${seed}
  UNION
  SELECT held.subject_type, held.subject_id FROM permissions AS held
    JOIN reached ON reached.kind = 'workflow' AND held.object_type = 'workflow'
      AND held.object_id = reached.id
  WHERE held.status = 'active' AND held.subject_type IN ('app', 'workflow')
    AND EXISTS (SELECT 1 FROM json_each(held.actions) WHERE value = 'start')
  UNION
  SELECT 'workflow', bound.resource_id FROM sdk_resource_bindings AS bound
    JOIN reached ON reached.kind = 'workflow' AND bound.kind = 'workflow'
      AND bound.target_id = reached.id
    JOIN workflow_resources AS binder ON binder.id = bound.resource_id
  WHERE binder.deleted_at IS NULL
),
reaching(app_id) AS (SELECT id FROM reached WHERE kind = 'app')`;
};

/** A random version 4 UUID, as SQL, for each row it is read in. */
const uuidSql = sql`lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) ||
  '-' || hex(randomblob(6))
)`;

/**
 * What a grant to `grantee` changes for the data policy of every App whose
 * reach it widens (`reachingSql`), when `condition` (that the grant
 * landed) holds as the statements run, for the grant's batch:
 *
 * - Data an admin had classified `ordinary` is `sensitive` again: they
 *   judged the data of an App with the access it had then. Recorded per
 *   App as a classification by whoever granted, with why (`because`).
 * - The policy generation of each of those Apps moves on, `sensitive` or
 *   not, so no classification an admin read before the grant lands after
 *   it.
 */
export const widenedByGrant = (
  db: DrizzleD1Database,
  by: Pick<Identity, "userId" | "staff">,
  grantee: Grantee,
  condition: SQL,
  because: Record<string, AuditDetailValue>
): BatchItem<"sqlite">[] => {
  const now = new Date();
  const reaching = sql`WITH RECURSIVE ${reachingSql(grantee)}`;
  const reached = sql`(${reaching} SELECT app_id FROM reaching)`;
  const ordinary = sql`${pagePolicies.output} = 'ordinary'
    AND ${pagePolicies.appId} IN ${reached}
    AND ${condition}`;
  const detail = JSON.stringify({
    output: "sensitive",
    previous: "ordinary",
    grantedTo: grantee.type === "app" ? grantee.appId : grantee.workflowId,
    ...because,
  });
  return [
    // Each event's ID is made once, then read twice.
    db.insert(auditOutbox).select(sql`${reaching},
      flipped AS MATERIALIZED (
        SELECT ${uuidSql} AS id, ${pagePolicies.appId} AS app_id
        FROM ${pagePolicies} WHERE ${ordinary}
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
    db.update(pagePolicies).set({ output: "sensitive" }).where(ordinary),
    db
      .insert(pagePolicies)
      // The table's columns, in its order.
      .select(
        sql`${reaching} SELECT app_id, 'sensitive', 1 FROM reaching WHERE ${condition}`
      )
      .onConflictDoUpdate({
        target: pagePolicies.appId,
        set: { generation: sql`${pagePolicies.generation} + 1` },
      }),
  ];
};

/**
 * The statement, for a grant's batch, that keeps a revocation for everyone
 * of each App whose data the grant to `grantee` (none, for an agent's)
 * makes `sensitive` again (`widenedByGrant`), when `condition` holds:
 * their open connections are told to look again (access-revocations.ts),
 * so a portable host's live query ends now. Put it before
 * `widenedByGrant`'s statements, which take away the `ordinary` that
 * finds them. Returns the rows kept, for `tellKept`.
 */
export const madeSensitiveByGrant = (
  db: DrizzleD1Database,
  grantee: Grantee | undefined,
  condition: SQL
) =>
  revocationsOf(
    db,
    grantee === undefined
      ? undefined
      : sql`${apps.id} IN (WITH RECURSIVE ${reachingSql(grantee)}
          SELECT app_id FROM reaching WHERE app_id IN (
            SELECT ${pagePolicies.appId} FROM ${pagePolicies}
            WHERE ${pagePolicies.output} = 'ordinary'))`,
    null,
    grantee === undefined ? sql`0` : condition
  );

/** What the App's data is now, and the policy generation it was read under. */
export const policyOf = async (
  env: Env,
  app: AppId
): Promise<Omit<DataPolicy, "app">> => {
  const row = await drizzle(env.DB).get<{
    output: OutputClass | null;
    generation: number;
  }>(
    sql`SELECT
      (SELECT ${pagePolicies.output} FROM ${pagePolicies} WHERE ${pagePolicies.appId} = ${app}) AS output,
      ${generationSql(app)} AS generation`
  );
  return { output: row.output ?? "sensitive", generation: row.generation };
};

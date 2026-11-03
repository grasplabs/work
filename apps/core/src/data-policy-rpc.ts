import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import {
  generationSchema,
  outputClassSchema,
} from "@grasp-os/shared/data-policy";
import type {
  DataPolicy,
  DataPolicyApi,
  OutputClass,
} from "@grasp-os/shared/data-policy";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { screenErrors } from "@grasp-os/shared/screens";
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { revocationsOf, tellKept } from "./access-revocations.ts";
import { appFor, editableApp } from "./apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "./audit-outbox.ts";
import { generationSql, policyOf } from "./data-policy.ts";
import { apps, screenPolicies } from "./db/core/schema.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdminSql,
} from "./permissions.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// An admin saying what an App's data is to code Grasp didn't serve
// (data-policy.ts). Only one of the organization's own admins classifies,
// from their own session: this is reached over a person's `/rpc` only,
// so no agent, workflow or App gets here, Grasp staff are refused, and
// that the admin still is one is part of the write.

/** What the App's data is now, for its builders, which every admin is. */
export const readPolicy = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<DataPolicy> => {
  const found = await appFor(env, by, app, "builder");
  return { app: found.id, ...(await policyOf(env, found.id)) };
};

/** The condition a classification's write carries: still an admin, and nothing changed since it was read. */
const reviewedUnder = (by: Identity, app: AppId, generation: number): SQL =>
  sql`${stillAdminSql(by)} AND ${generationSql(app)} = ${generation}`;

/**
 * Says what the App's data is to code Grasp didn't serve: `ordinary` is
 * an admin accepting that it goes to a portable host, `sensitive` takes
 * that back. One write, only while `by` is still an admin, that moves the
 * App's policy generation on and is recorded on its own
 * (`app.output.classified`). Saying `sensitive` again tells the App's open
 * connections to look again (access-revocations.ts), so a portable host's
 * live query ends now. Saying what already holds changes, records and
 * tells nothing.
 */
export const classifyOutput = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown,
  reviewed: unknown
): Promise<OutputClass> => {
  requireMemberAdmin(by);
  const found = await editableApp(env, by, app);
  const output = screenErrors.parse("screen.invalid", outputClassSchema, input);
  const generation = screenErrors.parse(
    "screen.invalid",
    generationSchema,
    reviewed
  );
  const db = drizzle(env.DB);
  const { output: previous } = await policyOf(env, found.id);
  if (previous === output) {
    return output;
  }
  const event = createAuditEvent(
    {
      actor: actorOf(by),
      action: "app.output.classified",
      target: { type: "app", id: found.id },
      detail: { output, previous },
    },
    "core"
  );
  const classified = await auditedBatch(env, db, [
    db
      .insert(screenPolicies)
      // The table's columns, in its order.
      .select(
        sql`SELECT ${found.id}, ${output}, 1 WHERE ${reviewedUnder(by, found.id, generation)}`
      )
      .onConflictDoUpdate({
        target: screenPolicies.appId,
        set: {
          output: sql`excluded.output`,
          generation: sql`${screenPolicies.generation} + 1`,
        },
        setWhere: sql`${screenPolicies.output} <> excluded.output`,
      }),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    revocationsOf(
      db,
      eq(apps.id, found.id),
      null,
      output === "sensitive" ? storedEvent(event.id) : sql`0`
    ),
  ]);
  await tellKept(env, classified[2]);
  const { output: now } = await policyOf(env, found.id);
  if (now !== output) {
    // Nothing landed: they are no longer an admin, or the App's policy
    // moved on since they read it (a classification, a grant).
    await requireStillAdmin(env, by);
    throw screenErrors.create("screen.review_outdated");
  }
  return now;
};

/**
 * A signed-in person's `dataPolicy`. Every call checks the session first
 * and hands the identity that check returned on; each function checks who
 * the person is now.
 */
export class DataPolicyRpc extends CoreRpcTarget implements DataPolicyApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async read(app: string): Promise<DataPolicy> {
    return await withPerson(
      this.#check,
      async (by) => await readPolicy(this.#env, by, app)
    );
  }

  async classify(
    app: string,
    output: OutputClass,
    generation: number
  ): Promise<OutputClass> {
    return await withPerson(
      this.#check,
      async (by) => await classifyOutput(this.#env, by, app, output, generation)
    );
  }
}

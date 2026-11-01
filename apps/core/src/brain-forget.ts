import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { brainErrors, brainForgetTargetSchema } from "@grasp-os/shared/brain";
import type {
  BrainForgetPreview,
  BrainForgetTarget,
} from "@grasp-os/shared/brain";
import { requireAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { forgottenBodyOf } from "./brain-records.ts";
import { brainRecords } from "./db/core/schema.ts";

// Taking a source, or some things that were said, out of the brain on an
// admin's word (`brain.forgetPreview`, `brain.forget`): the prototype's
// `lib/brain-forget.ts`. Built alongside the content purge (a Knowledge
// purge rewrites terms wherever they are, brain-records.ts
// `brainRecordErasure`) and the onboarding's own purge of what rested on
// a withdrawn interview (`purgeOnboardingRecords`): this takes whole
// records the admin names, which neither of them does. A person's own
// removal of their interview (GRA-332) stays the onboarding's.
//
// Threat model, and how each is closed:
//
// - Someone who shouldn't take things out: admins alone, on the live
//   session. Grasp's staff are admins, as they are for adding records.
// - Words left behind: a removed record's body is replaced, not marked.
//   A statement keeps only its type and id; a source its type, id, kind
//   and day, so what still names it can say it was removed. Retired
//   records citing the source go too: they are read by no one, but still
//   hold words. The brain's records have no copy elsewhere (no recall
//   index, no cache): `brain.read` builds every note and aggregate from
//   them on each read, so the notes resting on them go with them.
// - Something said in the source left: a source goes with every
//   statement whose source it is, found again as it is taken, so one
//   added between the preview and the yes goes too.
// - It coming back: the row stays, its id taken. The same record sent
//   again (the onboarding giving a team's claims again, under ids drawn
//   from their words) is left as removed, and nothing new may name it
//   (brain-records.ts `freshOf`). The onboarding's own purge leaves it.
// - The audit trail holding what was said: each record taken is audited
//   by its key alone (type and id), in the batch that takes it, and only
//   when the batch changed it, so a second call records nothing.
// - A preview that says less than goes: preview and forget find what goes
//   the same way (`planOf`); forget takes what is there when it runs.
// - Numbers losing their footing: a workflow drawn from the source keeps
//   its numbers, and names the source, which now reads as removed.

/** Records one batch takes out: two statements each. */
const recordsPerBatch = 40;

/** A record that goes, as stored. */
interface Going {
  id: string;
  type: string;
  body: string;
}

/** What goes with `target`, as core holds it now. */
interface Plan {
  source: Going | null;
  statements: Going[];
  workflows: string[];
}

/** The source record `id`, if the brain holds it; with `forgottenAt` set when it was taken out. */
const sourceRecord = async (env: Env, id: string) =>
  await drizzle(env.DB)
    .select({
      id: brainRecords.id,
      type: brainRecords.type,
      body: brainRecords.body,
      forgottenAt: brainRecords.forgottenAt,
    })
    .from(brainRecords)
    .where(and(eq(brainRecords.id, id), eq(brainRecords.type, "source")))
    .get();

/** The statements whose source is `sourceId`, not taken out yet, retired or not. */
const statementsOf = async (env: Env, sourceId: string): Promise<Going[]> =>
  await drizzle(env.DB)
    .select({
      id: brainRecords.id,
      type: brainRecords.type,
      body: brainRecords.body,
    })
    .from(brainRecords)
    .where(
      and(
        eq(brainRecords.type, "statement"),
        isNull(brainRecords.forgottenAt),
        sql`json_extract(${brainRecords.body}, '$.sourceId') = ${sourceId}`
      )
    );

/** The live workflows drawn from `sourceId`: the workflow's record, or a drawing of it, names it. */
const workflowsOf = async (env: Env, sourceId: string): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select({
      workflowId: sql<string>`case when ${brainRecords.type} = 'workflow' then ${brainRecords.id} else json_extract(${brainRecords.body}, '$.workflowId') end`,
    })
    .from(brainRecords)
    .where(
      and(
        inArray(brainRecords.type, ["workflow", "workflowVersion"]),
        isNull(brainRecords.retiredAt),
        isNull(brainRecords.forgottenAt),
        sql`json_extract(${brainRecords.body}, '$.sourceId') = ${sourceId}`
      )
    );
  return [...new Set(rows.map(({ workflowId }) => workflowId))];
};

/**
 * What goes with `target`: refuses one the brain doesn't hold as its own
 * record. One taken out already is no longer there to go.
 */
const planOf = async (env: Env, target: BrainForgetTarget): Promise<Plan> => {
  if ("source" in target) {
    const source = await sourceRecord(env, target.source);
    if (source === undefined) {
      throw brainErrors.create("brain.forget_missing");
    }
    const [statements, workflows] = await Promise.all([
      statementsOf(env, source.id),
      workflowsOf(env, source.id),
    ]);
    return {
      source: source.forgottenAt === null ? source : null,
      statements,
      workflows,
    };
  }
  const wanted = [...new Set(target.statements)];
  const rows = await drizzle(env.DB)
    .select({
      id: brainRecords.id,
      type: brainRecords.type,
      body: brainRecords.body,
      forgottenAt: brainRecords.forgottenAt,
    })
    .from(brainRecords)
    .where(
      and(eq(brainRecords.type, "statement"), inArray(brainRecords.id, wanted))
    );
  if (rows.length !== wanted.length) {
    throw brainErrors.create("brain.forget_missing");
  }
  return {
    source: null,
    statements: rows.flatMap(({ forgottenAt, ...row }) =>
      forgottenAt === null ? [row] : []
    ),
    workflows: [],
  };
};

/** `plan` as the preview says it: by id, in the order core holds them. */
const previewOf = (plan: Plan): BrainForgetPreview => ({
  source: plan.source?.id ?? null,
  statements: plan.statements.map(({ id }) => id).toSorted(),
  workflows: plan.workflows.toSorted(),
});

/**
 * Takes `going` out of the brain as `actor`: each record's body replaced
 * by what stays of it, and audited by its key alone, only when it was
 * still there to take. In bounded batches; the source last, so a call
 * cut short leaves it to be taken again with what is left of it.
 */
const takeOut = async (
  env: Env,
  actor: AuditActor,
  going: readonly Going[]
): Promise<void> => {
  const db = drizzle(env.DB);
  const forgottenAt = new Date();
  const take = (record: Going) =>
    [
      db
        .update(brainRecords)
        .set({ body: forgottenBodyOf(record), forgottenAt })
        .where(
          and(eq(brainRecords.id, record.id), isNull(brainRecords.forgottenAt))
        ),
      outboxedIfChanged(db, {
        actor,
        action: "brain.records.forgotten",
        target: { type: "brain_record", id: `${record.type}:${record.id}` },
      }),
    ] as const;
  for (let at = 0; at < going.length; at += recordsPerBatch) {
    const [first, ...rest] = going
      .slice(at, at + recordsPerBatch)
      .flatMap(take);
    if (first !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      await auditedBatch(env, db, [first, ...rest]);
    }
  }
};

/** What taking `input` out of the brain would take, as `person` asks: for admins. */
export const forgetPreview = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<BrainForgetPreview> => {
  requireAdmin(person);
  const target = brainErrors.parse(
    "brain.invalid",
    brainForgetTargetSchema,
    input
  );
  return previewOf(await planOf(env, target));
};

/** Takes `input` out of the brain, for good, as `person`: for admins. Returns what it took. */
export const forget = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<BrainForgetPreview> => {
  requireAdmin(person);
  const target = brainErrors.parse(
    "brain.invalid",
    brainForgetTargetSchema,
    input
  );
  const plan = await planOf(env, target);
  await takeOut(env, actorOf(person), [
    ...plan.statements,
    ...(plan.source === null ? [] : [plan.source]),
  ]);
  return previewOf(plan);
};

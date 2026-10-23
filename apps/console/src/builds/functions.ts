/**
 * Integrations to build's server functions (src/admin/integrations.tsx),
 * behind the Access check every request passes (src/access.ts): the
 * builds as the console records them, and the moves a person at Grasp
 * makes on one. Each move is the build's own (src/builds/builds.ts), so
 * it is audited as the verified staff member the request comes from, and
 * moves the build only from the stage it is for: a refusal is answered
 * as its code (`BuildErrorCode`), which the page words.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { eq, max } from "drizzle-orm";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { auditEvents, integrationBuilds } from "../db/schema.ts";
import {
  approvePlan,
  BuildError,
  confirmCredentials,
  requestBuild,
  sendBackPlan,
} from "./builds.ts";
import type { BuildErrorCode, BuildStage } from "./builds.ts";
import { buildPlanSchema } from "./plan.ts";
import type { BuildPlan } from "./plan.ts";

/**
 * A build as the page reads it: the console's record, its plan parsed,
 * its times as ISO strings, and when its plan was approved, as the audit
 * log has it. Its run's id stays in the console.
 */
export interface BuildRecord {
  app: string;
  name: string;
  stage: BuildStage;
  stoppedAt: BuildStage | null;
  reason: string | null;
  plan: BuildPlan | null;
  planRound: number;
  planNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  branch: string | null;
  pullRequest: number | null;
  mergeCommitSha: string | null;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

const stageSchema = z.enum(integrationBuilds.stage.enumValues);

/** A plan as recorded, or null for one that no longer parses: it is never shown half. */
const planOf = (plan: string | null): BuildPlan | null => {
  if (plan === null) {
    return null;
  }
  try {
    return buildPlanSchema.safeParse(JSON.parse(plan)).data ?? null;
  } catch {
    return null;
  }
};

/** Every build the console records, with when each plan was approved. */
export const listBuilds = async (
  db: ConsoleDatabase
): Promise<BuildRecord[]> => {
  const [rows, approvals] = await Promise.all([
    db.select().from(integrationBuilds),
    db
      .select({ app: auditEvents.target, at: max(auditEvents.at) })
      .from(auditEvents)
      .where(eq(auditEvents.action, "build.approve"))
      .groupBy(auditEvents.target),
  ]);
  const approvedAt = new Map(
    approvals.map(({ app, at }) => [app, at?.toISOString() ?? null])
  );
  return rows.map(
    ({ runId: _runId, plan, stoppedAt, createdAt, updatedAt, ...row }) => ({
      ...row,
      plan: planOf(plan),
      stoppedAt: stageSchema.safeParse(stoppedAt).data ?? null,
      approvedAt:
        row.approvedBy === null ? null : (approvedAt.get(row.app) ?? null),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    })
  );
};

/** Every build the console records (`listBuilds`). */
export const fetchIntegrationBuilds = createServerFn({ method: "GET" }).handler(
  async () => await listBuilds(consoleDatabase(env.DB))
);

/** What a move on a build answers: refused with a code, or not. */
export interface BuildChange {
  refused: BuildErrorCode | null;
}

/** Runs `task`, a refusal answered as its code. */
const change = async (task: () => Promise<unknown>): Promise<BuildChange> => {
  try {
    await task();
    return { refused: null };
  } catch (error) {
    if (error instanceof BuildError) {
      return { refused: error.code };
    }
    throw error;
  }
};

/** An app's build, by its key. */
const appSchema = z.object({ app: z.string().min(1).max(64) });

/** A plan a person read, by its round. */
const roundSchema = appSchema.extend({ round: z.int().min(1) });

/** Build it, confirmed: the app's build starts, once however many ask. */
export const requestBuildFn = createServerFn({ method: "POST" })
  .validator(appSchema.extend({ name: z.string().min(1).max(200) }))
  .handler(
    async ({ data, context }) =>
      await change(async () => await requestBuild(env, context.staff, data))
  );

/** Approves the plan of the round the person read. */
export const approvePlanFn = createServerFn({ method: "POST" })
  .validator(roundSchema)
  .handler(
    async ({ data, context }) =>
      await change(
        async () => await approvePlan(env, context.staff, data.app, data.round)
      )
  );

/** Sends the plan of the round the person read back, with what to change. */
export const sendBackPlanFn = createServerFn({ method: "POST" })
  .validator(roundSchema.extend({ note: z.string().max(4000) }))
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await sendBackPlan(env, context.staff, data.app, data.round, data.note);
      })
  );

/** Grasp is registered with the app and its keys are in Secrets Store: the keys never pass here. */
export const confirmCredentialsFn = createServerFn({ method: "POST" })
  .validator(appSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await confirmCredentials(env, context.staff, data.app);
      })
  );

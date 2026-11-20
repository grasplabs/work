import type { Json } from "@grasp-os/shared/json";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { workflowState } from "../src/db/core/schema.ts";

/**
 * What workflow `workflowId` keeps stored now, by key, whoever may read
 * it: what tests compare with what runs wrote, as core's database holds
 * it (core reads it only through workflow-state.ts's checks).
 */
export const workflowStateOf = async (
  env: Pick<Env, "DB">,
  workflowId: string
): Promise<Record<string, Json>> => {
  const rows = await drizzle(env.DB)
    .select({ key: workflowState.key, value: workflowState.value })
    .from(workflowState)
    .where(eq(workflowState.workflowResourceId, workflowId))
    .orderBy(asc(workflowState.key));
  return Object.fromEntries(
    rows.map(({ key, value }) => [key, z.json().parse(JSON.parse(value))])
  );
};

/**
 * Keeps `kept` in workflow `workflowId`'s state, set by a run that read a
 * version of a source the Brain doesn't have: checking it asks the Brain,
 * which refuses it, so a start reads it as unset. Its id.
 */
export const keptFromTheBrain = async (
  env: Pick<Env, "DB">,
  workflowId: string
): Promise<string> => {
  const writer = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workflow_state (workflow_resource_id, key, value, run_id, updated_at) VALUES (?, 'kept', '"copied"', ?, ?)`
    ).bind(workflowId, writer, Date.now()),
    env.DB.prepare(
      "INSERT INTO run_brain_versions (run_id, producer, source_id, version, permission_id, recorded_at) VALUES (?, 'upload', ?, 1, 'brain', ?)"
    ).bind(writer, crypto.randomUUID(), Date.now()),
  ]);
  return writer;
};

/** `env` whose Brain is out of reach: every store refuses to be reached. */
export const brainAway = (env: Env): Env => ({
  ...env,
  BRAIN_STORE: new Proxy(env.BRAIN_STORE, {
    get: (target, property): unknown => {
      if (property === "getByName" || property === "get") {
        return () => {
          throw new Error("The Brain is out of reach");
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
});

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

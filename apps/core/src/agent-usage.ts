import type { AgentUsage } from "@grasp-os/shared/agents";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { listAgents } from "./agent-builder.ts";
import { firstAgentId } from "./agents.ts";
import { modelUsage } from "./db/core/schema.ts";

// What each of the company's agents used of the organization's models,
// for admins to read on the Agents pages: what it cost this month and the
// month before, how many requests to a model it made, for how many
// people, and when it last made one. Counted from the usage the model
// gateway records per request (model-usage.ts), which names the agent
// that asked. Rows from before agents were told apart name none: they
// were all the organization's one agent's, and count as the first
// agent's. Only what an agent asked counts, never a workflow's or a
// person's own call, and only on the organization's keys.
//
// It says how much, never what: no question, no answer, no person's name.
// An agent an admin deleted is left out, though its usage stays in the
// month's total (model-spend.ts).

/** The month before `month` (`yyyy-mm`), as a month. */
export const monthBefore = (month: string): string => {
  const [year = 0, of = 1] = month.split("-").map(Number);
  return of === 1
    ? `${year - 1}-12`
    : `${year}-${String(of - 1).padStart(2, "0")}`;
};

/** What every agent used in `month`, the first agent first, then by name. */
export const agentsUsage = async (
  env: Env,
  month: string
): Promise<AgentUsage[]> => {
  const before = monthBefore(month);
  // The agent a row counts for: the one it names, else the first.
  const agent = sql<string>`coalesce(${modelUsage.agentId}, ${firstAgentId})`;
  const [agents, rows] = await Promise.all([
    listAgents(env),
    drizzle(env.DB)
      .select({
        agentId: agent,
        period: modelUsage.period,
        spent: sql<number>`sum(${modelUsage.cost})`,
        requests: sql<number>`count(*)`,
        people: sql<number>`count(DISTINCT ${modelUsage.personId})`,
        lastAt: sql<number>`max(${modelUsage.createdAt})`,
      })
      .from(modelUsage)
      .where(
        and(
          inArray(modelUsage.period, [month, before]),
          eq(modelUsage.triggerType, "agent"),
          or(
            eq(modelUsage.credential, "organization"),
            eq(modelUsage.feature, "organization")
          )
        )
      )
      .groupBy(agent, modelUsage.period),
  ]);
  const of = (agentId: string, period: string) =>
    rows.find((row) => row.agentId === agentId && row.period === period);
  return agents.map(({ id }) => {
    const now = of(id, month);
    const earlier = of(id, before);
    const lastAt = now?.lastAt ?? earlier?.lastAt;
    return {
      agentId: id,
      month,
      spent: now?.spent ?? 0,
      spentBefore: earlier?.spent ?? 0,
      requests: now?.requests ?? 0,
      people: now?.people ?? 0,
      lastAt: lastAt === undefined ? null : new Date(lastAt).toISOString(),
    };
  });
};

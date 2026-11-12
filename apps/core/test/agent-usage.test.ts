import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { agentsUsage, monthBefore } from "../src/agent-usage.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { modelUsage } from "../src/db/core/schema.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// What each agent used of the organization's models, as the Agents pages
// read it. These start from the ways it can fail: one agent's usage
// counted as another's; usage from before agents were told apart lost
// instead of counted as the first agent's; a workflow's or a person's own
// calls, or Grasp's own on Grasp's key, counted as an agent's; another
// month's usage counted in this one; a deleted agent still listed; someone
// who isn't an admin reading it.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A month no other test counts in. */
const month = "2411-03";
const before = "2411-02";

let rows = 0;

/** One recorded request, with `over` its own. */
const used = (over: Partial<typeof modelUsage.$inferInsert>) => {
  rows += 1;
  return {
    id: `agent-usage-${rows}-${crypto.randomUUID()}`,
    period: month,
    personId: "person-a",
    triggerType: "agent",
    agentId: null,
    model: "anthropic/claude-sonnet-4-5",
    credential: "organization",
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 1,
    estimated: false,
    createdAt: new Date("2411-03-10T09:00:00.000Z"),
    ...over,
  };
};

/** Records `requests`, a few at a time: D1 takes a hundred values a statement. */
const record = async (
  requests: (typeof modelUsage.$inferInsert)[]
): Promise<void> => {
  const db = drizzle(env.DB);
  await db.batch([
    db.insert(modelUsage).values(requests.slice(0, 5)),
    ...(requests.length > 5
      ? [db.insert(modelUsage).values(requests.slice(5, 10))]
      : []),
  ]);
};

describe("what each agent used", setUpTime, () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
      env.DB.prepare("DELETE FROM model_usage WHERE period IN (?, ?)").bind(
        month,
        before
      ),
    ]);
  });

  it("names the month before a month, across a year's end", () => {
    expect([monthBefore("2026-11"), monthBefore("2027-01")]).toStrictEqual([
      "2026-10",
      "2026-12",
    ]);
  });

  it("counts each agent's own requests in the month, and those naming no agent as the first agent's", async () => {
    const admin = await signedInApi(idp, "admin");
    const said = {
      face: "stephen",
      job: "",
      instructions: "",
      modelRole: null,
    };
    const claire = await admin.api.connections.makeAgent({
      ...said,
      name: "Claire",
    });
    const gone = await admin.api.connections.makeAgent({
      ...said,
      name: "Gone",
    });
    await record([
      // The first agent's: two from before agents were told apart, one named.
      used({ cost: 1 }),
      used({ cost: 2, personId: "person-b" }),
      used({
        cost: 4,
        agentId: chatAgentId,
        createdAt: new Date("2411-03-20T12:00:00.000Z"),
      }),
      used({ cost: 8, period: before }),
      // Claire's, for one person twice.
      used({ cost: 0.5, agentId: claire.id }),
      used({ cost: 0.25, agentId: claire.id }),
      // Nobody's: a workflow's, a person's own, and Grasp's on its own key.
      used({ cost: 100, triggerType: "workflow" }),
      used({ cost: 100, triggerType: "person" }),
      used({ cost: 100, agentId: claire.id, credential: "platform" }),
      // A deleted agent's.
      used({ cost: 50, agentId: gone.id }),
    ]);
    await admin.api.connections.deleteAgent(gone.id);

    await expect(agentsUsage(env, month)).resolves.toStrictEqual([
      {
        agentId: chatAgentId,
        month,
        spent: 7,
        spentBefore: 8,
        requests: 3,
        people: 2,
        lastAt: "2411-03-20T12:00:00.000Z",
      },
      {
        agentId: claire.id,
        month,
        spent: 0.75,
        spentBefore: 0,
        requests: 2,
        people: 1,
        lastAt: "2411-03-10T09:00:00.000Z",
      },
    ]);
  });

  it("says nothing was used of an agent that made no request, and when it last did the month before", async () => {
    await record([
      used({
        period: before,
        createdAt: new Date("2411-02-03T08:00:00.000Z"),
      }),
    ]);
    await expect(agentsUsage(env, month)).resolves.toStrictEqual([
      {
        agentId: chatAgentId,
        month,
        spent: 0,
        spentBefore: 1,
        requests: 0,
        people: 0,
        lastAt: "2411-02-03T08:00:00.000Z",
      },
    ]);
  });

  it("is an admin's to read, never a member's", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await expect(outcome(member.api.connections.agentsUsage())).resolves.toBe(
      "role.forbidden"
    );
    await expect(admin.api.connections.agentsUsage()).resolves.toMatchObject([
      { agentId: chatAgentId },
    ]);
  });
});

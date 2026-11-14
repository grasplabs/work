import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { readAgent, turnAgent } from "../src/agents.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { outcome } from "./sign-in.ts";

// The company's agents as core reads them. These start from the ways the
// move from one unnamed agent to records can fail: a deployment that had
// no rows losing the agent its grants, chats and memory name; an ID nobody
// made reading as an agent; an ID that could reach outside an agent's own
// memory path reading as one.

/** Keeps an agent as an admin would have made or changed it. */
const keepAgent = async (
  id: string,
  { name, state }: { name: string; state: "on" | "paused" }
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO agents
       (id, name, face, job, instructions, model_role, state, made_by, made_at, changed_by, changed_at)
     VALUES (?, ?, 'claire', 'Chases unpaid invoices.', 'Answer only about invoices.', 'careful', ?, 'admin-1', ?, 'admin-2', ?)`
  )
    .bind(id, name, state, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 2))
    .run();
};

describe("the company's agents", () => {
  beforeEach(async () => {
    // Every test starts as a deployment from before agents were records.
    await env.DB.prepare("DELETE FROM agents").run();
  });

  it("reads the agent every chat already has as the first one, on, with no row kept", async () => {
    // The ID every grant, chat and memory path made before names.
    expect(chatAgentId).toBe("organization");
    const first = await readAgent(env, chatAgentId);
    expect(first).toMatchObject({
      id: chatAgentId,
      name: "Stephen",
      state: "on",
      instructions: "",
      modelRole: null,
      changedBy: null,
      changedAt: null,
    });
  });

  it("reads the first agent as an admin changed it, under the same ID", async () => {
    await keepAgent(chatAgentId, { name: "Ada", state: "paused" });
    await expect(readAgent(env, chatAgentId)).resolves.toStrictEqual({
      id: chatAgentId,
      name: "Ada",
      face: "claire",
      job: "Chases unpaid invoices.",
      instructions: "Answer only about invoices.",
      modelRole: "careful",
      model: null,
      state: "paused",
      // One of the company's: nobody's own.
      ownerId: null,
      changedBy: "admin-2",
      changedAt: "2026-11-02T00:00:00.000Z",
    });
  });

  it("reads a second agent beside the first, each under its own ID", async () => {
    await keepAgent("invoice-chaser", { name: "Claire", state: "on" });
    const [first, second] = await Promise.all([
      readAgent(env, chatAgentId),
      readAgent(env, "invoice-chaser"),
    ]);
    expect(first).toMatchObject({ id: chatAgentId, name: "Stephen" });
    expect(second).toMatchObject({ id: "invoice-chaser", name: "Claire" });
  });

  it("has no agent under an ID nobody made", async () => {
    await keepAgent("invoice-chaser", { name: "Claire", state: "on" });
    await expect(readAgent(env, "payroll")).resolves.toBeUndefined();
    await expect(readAgent(env, "Invoice-Chaser")).resolves.toBeUndefined();
  });

  it("has no agent under an ID that isn't one, even with a row under it", async () => {
    // Such an ID would reach outside `agents/<id>/` as a memory path.
    await keepAgent("../organization", { name: "Mallory", state: "on" });
    await expect(readAgent(env, "../organization")).resolves.toBeUndefined();
    await expect(readAgent(env, "")).resolves.toBeUndefined();
  });

  it("lets a turn run as an agent that is on, and as none that is paused", async () => {
    await keepAgent("invoice-chaser", { name: "Claire", state: "on" });
    await keepAgent("payroll", { name: "Pat", state: "paused" });
    await expect(turnAgent(env, chatAgentId)).resolves.toMatchObject({
      name: "Stephen",
    });
    await expect(turnAgent(env, "invoice-chaser")).resolves.toMatchObject({
      name: "Claire",
    });
    await expect(outcome(turnAgent(env, "payroll"))).resolves.toBe(
      "agent.paused"
    );
  });
});

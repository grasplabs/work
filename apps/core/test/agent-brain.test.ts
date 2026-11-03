import type { AuditEvent } from "@grasp-os/shared/audit";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  says,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The company brain for a chat's code (`env.brain`) and its `searchBrain`
// tool: read as the chat's person, with no grant (a person's own chat is
// their tool, a chat for an App they build too), never past what they may
// read, and every call recorded as the chat's agent's.
// Its open questions are the brain's gaps (GRA-527): an answered or
// closed one is no longer open, and an answer never reaches the agent.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** What `env.brain.gaps()` answered, or the message it was refused with. */
const askGaps = codeStep(
  "export default async (self, env) => { try { return await env.brain.gaps(); } catch (error) { return error.message; } };"
);

/** The chat agent's `brain.gaps` calls, once `count` are recorded. */
const gapCalls = async (
  agentId: string,
  count: number
): Promise<AuditEvent[]> =>
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      const calls = events.filter(
        ({ actor, action, detail }) =>
          action === "agent.call" &&
          detail.method === "brain.gaps" &&
          actor.type === "agent" &&
          actor.agentId === agentId
      );
      expect(calls).toHaveLength(count);
      return calls;
    },
    { timeout: 10_000, interval: 50 }
  );

describe("a chat's brain", setUpTime, () => {
  it("reads its open questions with no grant, and records every read", async () => {
    const person = await signedInWithRole(idp, "user");
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      askGaps,
      says("None open.")
    );
    const { chat, ask } = await newChat();
    await ask("What's still unknown?");

    const calls = await gapCalls(agent.agentId, 1);
    const steps = await codeResults(stub, chat.id);
    expect({
      steps: steps.map(({ text }) => text),
      calls: calls.map(({ actor, detail }) => ({
        onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
        outcome: detail.outcome,
        reason: detail.reason,
      })),
    }).toStrictEqual({
      steps: ["Returned:\n[]"],
      calls: [{ onBehalfOf: person.userId, outcome: "ok", reason: null }],
    });
  });

  it("reads the questions still open as the person, and none of an answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const records: BrainRecordInput[] = [
      {
        type: "source",
        id: "src-agent",
        kind: "interview",
        title: "Finance interview",
        date: "2026-10-20",
      },
      {
        type: "gap",
        id: "gap-open",
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: "src-agent",
        about: [],
      },
      {
        type: "gap",
        id: "gap-answered",
        question: "Who approves a refund?",
        owner: "Head of finance",
        sourceId: "src-agent",
        about: [],
      },
    ];
    await admin.api.brain.addRecords(records);
    const secret = "Refunds go through Ann, cell 555 0100.";
    await member.api.brain.answerGap("gap-answered", secret);
    const { stub, newChat } = await personalChatsOf(
      member.userId,
      askGaps,
      says("One is open.")
    );
    const { chat, ask } = await newChat();
    await ask("What's still unknown?");

    const [read] = await codeResults(stub, chat.id);
    const text = read?.text ?? "";
    expect(text).not.toContain(secret);
    expect(JSON.parse(text.replace(/^Returned:\n/u, ""))).toStrictEqual([
      {
        id: "gap-open",
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: "src-agent",
        about: [],
      },
    ]);
  });

  it("searches the brain for its person with no grant, in their own chat and in one for an App they build, never past what they may read", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = `The depot opens at ${unique()}`;
    const canary = `team canary ${unique()}`;
    // A team the builder isn't in.
    const teamId = await newTeam(admin, [admin]);
    const [open, team] = await Promise.all([
      admin.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      }),
      admin.api.knowledge.createCollection({
        name: `Team ${unique()}`,
        access: "teams",
        teams: [teamId],
      }),
    ]);
    await Promise.all([
      admin.api.knowledge.saveDocument({
        collectionId: open.id,
        path: "depot.md",
        text: `# Depot ${word}\n\n${fact}.`,
        ifVersion: 0,
      }),
      admin.api.knowledge.saveDocument({
        collectionId: team.id,
        path: "plan.md",
        text: `# Plan ${word}\n\n${canary}.`,
        ifVersion: 0,
      }),
    ]);
    const app = await builder.api.apps.create({ name: `Depot ${unique()}` });
    const search = toolStep("searchBrain", { query: word });
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      search,
      says("It opens then."),
      search,
      says("It opens then, for the App too.")
    );
    const { chat, ask } = await newChat();
    await ask("When does the depot open?");
    const forApp = await builder.api.chats.forApp(app.id);
    await stub.ask(forApp.id, { text: "When does the depot open?", model });

    const searched = async (chatId: string) => {
      const results = await toolResults(stub, chatId);
      return results
        .filter(({ tool }) => tool === "searchBrain")
        .map(({ isError, text }) => ({
          isError,
          found: text.includes(fact),
          leaked: text.includes(canary),
        }));
    };
    const read = { isError: false, found: true, leaked: false };
    expect({
      own: await searched(chat.id),
      forApp: await searched(forApp.id),
    }).toStrictEqual({ own: [read], forApp: [read] });
  });
});

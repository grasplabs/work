import type { AuditEvent } from "@grasp-os/shared/audit";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { addSource } from "../src/brain-next.ts";
import { turnRecallMethod, turnRecallTool } from "../src/turn-recall.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  says,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The company brain for a chat's code (`env.brain`): read as the chat's
// person, only once the agent holds the brain permission (a platform
// permission, `brain`), and every call recorded as the chat's agent's.
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
  it("has its open questions only once the agent holds the brain permission, and records every read", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      askGaps,
      says("None I can see."),
      askGaps,
      says("None open.")
    );
    const before = await newChat();
    await before.ask("What's still unknown?");
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const after = await newChat();
    await after.ask("What's still unknown?");

    const calls = await gapCalls(agent.agentId, 1);
    const beforeSteps = await codeResults(stub, before.chat.id);
    // Once granted, the turn recalls for the question before the model's
    // first request (turn-recall.ts): its own search step, then the
    // model's code step.
    const [read] = await codeResults(stub, after.chat.id);
    const [recalled] = await toolResults(stub, after.chat.id);
    expect({
      before: beforeSteps.map(({ text }) => text),
      recalled:
        recalled?.tool === "searchBrain" &&
        recalled.text.startsWith('Returned:\n{"note":'),
      after: read?.text,
      calls: calls.map(({ actor, detail }) => ({
        onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
        outcome: detail.outcome,
        reason: detail.reason,
      })),
    }).toStrictEqual({
      // Without the permission, no recall step and no `env.brain` at
      // all: nothing is called, so nothing is refused.
      before: [expect.stringContaining("This chat has no API named env.brain")],
      recalled: true,
      after: "Returned:\n[]",
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
    const { stub, agent, newChat } = await personalChatsOf(
      member.userId,
      askGaps,
      says("One is open.")
    );
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const { chat, ask } = await newChat();
    await ask("What's still unknown?");

    // The recall before the first request, then the model's own read.
    const [recalled] = await toolResults(stub, chat.id);
    const [read] = await codeResults(stub, chat.id);
    const text = read?.text ?? "";
    expect(recalled?.text).not.toContain(secret);
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

  it("is offered only once the agent holds the brain permission: without it no call is refused, and building goes on", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = `The depot opens at ${unique()}`;
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `Depot ${word}: ${fact}.`,
      // A team's of the builder's: the agent reads as their teams.
      readers: { kind: "team", teamId: await newTeam(admin, [builder]) },
    });
    const app = await builder.api.apps.create({ name: `Depot ${unique()}` });
    const { stub, agent, provider, newChat } = await personalChatsOf(
      builder.userId,
      toolStep("writeFile", { app: app.id, files: { "notes.md": "Depot" } }),
      says("Written."),
      toolStep("searchBrain", { question: word }),
      says("It opens then.")
    );
    const forApp = await builder.api.chats.forApp(app.id);
    await stub.ask(forApp.id, { text: "Note the depot.", model });
    const withoutGrant = provider.requests.length;
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const { chat, ask } = await newChat();
    await ask("When does the depot open?");

    const offered = (from: number, to?: number) =>
      provider.requests.slice(from, to).map(({ body }) => {
        const sent = JSON.stringify(body);
        return {
          tool: sent.includes('"name":"searchBrain"'),
          api: sent.includes("env.brain:"),
        };
      });
    const built = await toolResults(stub, forApp.id);
    const searched = await toolResults(stub, chat.id);
    expect({
      without: offered(0, withoutGrant),
      built: built.map(({ tool, isError }) => [tool, isError]),
      with: offered(withoutGrant).at(0),
      searched: searched
        .filter(({ tool }) => tool === "searchBrain")
        .map(({ isError, text }) => [isError, text.includes(fact)]),
    }).toStrictEqual({
      without: Array.from({ length: withoutGrant }, () => ({
        tool: false,
        api: false,
      })),
      built: [["writeFile", false]],
      with: { tool: true, api: true },
      // The recall before the question, then the model's own search: both
      // find the note of the builder's team.
      searched: [
        [false, true],
        [false, true],
      ],
    });
  });

  it("recalls nothing before a question while the agent lacks the brain permission, and recalls once it holds it", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const depot = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = `Depot ${depot} opens at seven`;
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: fact,
      readers: { kind: "owner", personId: person.userId },
    });
    const { stub, chat, provider, ask, agent } = await chatOf(
      person.userId,
      says("I can't look."),
      says("Seven.")
    );
    const question = `When does depot ${depot} open?`;

    await ask(question);
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    await ask(question);

    /** Each request's own recall part, if it carries one. */
    const recalled = provider.requests.map(({ body }) =>
      JSON.stringify(body).includes("[Recall ")
    );
    // Once the granted turn's recall is in the log: the first turn's
    // would be before it.
    const recalls = await vi.waitFor(
      async () => {
        const logged = await allEvents();
        const events = logged.filter(
          ({ action, detail }) =>
            action === "agent.call" &&
            detail.method === turnRecallMethod &&
            detail.chat === chat.id
        );
        expect(events.length).toBeGreaterThan(0);
        return events;
      },
      { timeout: 10_000, interval: 50 }
    );
    const results = await toolResults(stub, chat.id);
    const steps = results.filter(({ tool }) => tool === turnRecallTool);
    expect({
      recalled,
      steps: steps.map(({ text }) => text.includes(fact)),
      recalls: recalls.length,
    }).toStrictEqual({
      // The first request, before the grant, carried none.
      recalled: [false, true],
      steps: [true],
      recalls: 1,
    });
  });
});

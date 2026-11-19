import type { AuditEvent } from "@grasp-os/shared/audit";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { addSource } from "../src/brain-next.ts";
import { turnRecallMethod, turnRecallTool } from "../src/turn-recall.ts";
import { newTeam } from "./admin-teams.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  personalChatsOf,
  says,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The company brain for a chat's code (`env.brain`): read as the chat's
// person, by every agent with no grant (GRA-2203), and every call
// recorded as the chat's agent's. Its open questions are the brain's gaps
// (GRA-527): an answered or closed one is no longer open, and an answer
// never reaches the agent.

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
  it("has its open questions with no grant, and records every read", async () => {
    const person = await signedInWithRole(idp, "user");
    const { stub, agent, chat, ask } = await chatOf(
      person.userId,
      askGaps,
      says("None open.")
    );
    await ask("What's still unknown?");

    const calls = await gapCalls(agent.agentId, 1);
    // The turn recalls for the question before the model's first request
    // (turn-recall.ts): its own search step, then the model's code step.
    const [read] = await codeResults(stub, chat.id);
    const [recalled] = await toolResults(stub, chat.id);
    expect({
      recalled:
        recalled?.tool === "searchBrain" &&
        recalled.text.startsWith('Returned:\n{"note":'),
      read: read?.text,
      calls: calls.map(({ actor, detail }) => ({
        onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
        outcome: detail.outcome,
        reason: detail.reason,
      })),
    }).toStrictEqual({
      recalled: true,
      read: "Returned:\n[]",
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

  it("is offered with no grant, as the search tool and `env.brain` from the first request, and both find what the person's team may read", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const word = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = `The depot opens at ${unique()}`;
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `Depot ${word}: ${fact}.`,
      // A team's of the person's: the agent reads as their teams.
      readers: { kind: "team", teamId: await newTeam(admin, [person]) },
    });
    const { stub, chat, provider, ask } = await chatOf(
      person.userId,
      toolStep("searchBrain", { question: word }),
      says("It opens then.")
    );
    await ask("When does the depot open?");

    const [first] = provider.requests.map(({ body }) => {
      const sent = JSON.stringify(body);
      return {
        tool: sent.includes('"name":"searchBrain"'),
        api: sent.includes("env.brain:"),
      };
    });
    const searched = await toolResults(stub, chat.id);
    expect({
      first,
      searched: searched
        .filter(({ tool }) => tool === "searchBrain")
        .map(({ isError, text }) => [isError, text.includes(fact)]),
    }).toStrictEqual({
      first: { tool: true, api: true },
      // The recall before the question, then the model's own search: both
      // find the note of the person's team.
      searched: [
        [false, true],
        [false, true],
      ],
    });
  });

  it("recalls before every question with no grant", async () => {
    const person = await signedInWithRole(idp, "user");
    const depot = `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
    const fact = `Depot ${depot} opens at seven`;
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: fact,
      readers: { kind: "owner", personId: person.userId },
    });
    const { stub, chat, provider, ask } = await chatOf(
      person.userId,
      says("Seven."),
      says("Still seven.")
    );
    const question = `When does depot ${depot} open?`;

    await ask(question);
    await ask(question);

    /** Each request's own recall part, if it carries one. */
    const recalled = provider.requests.map(({ body }) =>
      JSON.stringify(body).includes("[Recall ")
    );
    const recalls = await vi.waitFor(
      async () => {
        const logged = await allEvents();
        const events = logged.filter(
          ({ action, detail }) =>
            action === "agent.call" &&
            detail.method === turnRecallMethod &&
            detail.chat === chat.id
        );
        expect(events).toHaveLength(2);
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
      recalled: [true, true],
      steps: [true, true],
      recalls: 2,
    });
  });
});

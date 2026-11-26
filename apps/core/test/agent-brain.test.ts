import type { AuditEvent } from "@grasp-os/shared/audit";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { withheldResult } from "../src/agent.ts";
import { addSource, forgetAs, rememberAs } from "../src/brain-next.ts";
import { turnRecallMethod } from "../src/brain-search.ts";
import { newTeam } from "./admin-teams.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  readResult,
  returnedOf,
  returnedText,
  says,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { outcome, signedInApi, signedInWithRole, unique } from "./sign-in.ts";

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

/** A result's fields, but what it returned, and what type that is. */
const shapeOf = (text: string | undefined) => {
  const { returned, ...rest } = readResult(text);
  return { ...rest, returns: typeof returned };
};

describe("a chat's brain", setUpTime, () => {
  it("has its open questions with no grant, records every read, and hands the model the recall, a code step and a tool's call in one shape", async () => {
    const person = await signedInWithRole(idp, "user");
    const { stub, agent, chat, ask } = await chatOf(
      person.userId,
      askGaps,
      toolStep("searchBrain", { question: "What is still unknown?" }),
      says("None open.")
    );
    await ask("What's still unknown?");

    const calls = await gapCalls(agent.agentId, 1);
    // The turn recalls for the question before the model's first request
    // (turn-recall.ts): its own search step, then the model's code step
    // and its tool's call.
    const [read] = await codeResults(stub, chat.id);
    const [recalled] = await toolResults(stub, chat.id, { recalls: true });
    const results = await toolResults(stub, chat.id);
    const searched = results.find(({ tool }) => tool === "searchBrain");
    expect({
      recalled: recalled?.tool === "searchBrain" && shapeOf(recalled.text),
      searched: searched?.tool === "searchBrain" && shapeOf(searched.text),
      read: read?.text,
      calls: calls.map(({ actor, detail }) => ({
        onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
        outcome: detail.outcome,
        reason: detail.reason,
      })),
    }).toStrictEqual({
      recalled: { returns: "object" },
      searched: { returns: "object" },
      read: returnedText([]),
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
    const [recalled] = await toolResults(stub, chat.id, { recalls: true });
    const [read] = await codeResults(stub, chat.id);
    const text = read?.text ?? "";
    expect(recalled?.text).not.toContain(secret);
    expect(text).not.toContain(secret);
    expect(returnedOf(text)).toStrictEqual([
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
    const searched = [
      ...(await toolResults(stub, chat.id, { recalls: true })),
      ...(await toolResults(stub, chat.id)),
    ];
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
      JSON.stringify(body).includes("<recall ")
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
    const steps = await toolResults(stub, chat.id, { recalls: true });
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

/** A word no other test's sources hold: letters only. */
const word = () => `zs${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;

/**
 * A member's Brain for the search: an old memory of their own about a
 * customer (never their profile, which comes with every question), a
 * document only they may read (unless `ownDocument` is false), and one
 * everyone may read, all holding `depot`.
 */
const searchedBrainOf = async (
  personId: string,
  depot: string,
  { ownDocument = true }: { ownDocument?: boolean } = {}
) => {
  const memory = `Depot ${depot} opens at seven, says the person`;
  const own = `Depot ${depot}: the person's own note.`;
  const everyone = `Depot ${depot}: the handbook everyone reads.`;
  const { memory: memoryId } = await rememberAs(env, personId, {
    change: crypto.randomUUID(),
    about: { kind: "customer", names: [`Depot ${depot}`] },
    type: "fact",
    statement: memory,
    quote: memory,
  });
  for (const [text, readers] of [
    ...(ownDocument ? [[own, { kind: "owner", personId }] as const] : []),
    [everyone, { kind: "everyone" }] as const,
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one source at a time
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text,
      readers,
    });
  }
  return { memory, memoryId, own, everyone };
};

/**
 * The audit event of the model's own search in chat `chatId` (never the
 * recall before its question, whose run is a `recall_…` call's), once it
 * is in the log.
 */
const searchEventOf = async (
  stub: Parameters<typeof toolResults>[0],
  chatId: string
): Promise<AuditEvent> => {
  const runs = await runInDurableObject(stub, (_object, state) =>
    state.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM chat_code_runs WHERE chat_id = ? AND tool_call_id NOT LIKE 'recall\\_%' ESCAPE '\\'",
        chatId
      )
      .toArray()
      .map(({ id }) => id)
  );
  return await vi.waitFor(
    async () => {
      const events = await allEvents();
      const found = events.find(
        ({ action, detail }) =>
          action === "agent.call" &&
          detail.method === turnRecallMethod &&
          typeof detail.run === "string" &&
          runs.includes(detail.run)
      );
      if (found === undefined) {
        throw new Error("No audit event of the search yet");
      }
      return found;
    },
    { timeout: 10_000, interval: 50 }
  );
};

describe("the model's search of the brain", setUpTime, () => {
  it("searches the whole brain in one call: an old memory of the person's own the recall before the question didn't hand over, their document and what everyone may read, and marks the chat", async () => {
    const person = await signedInWithRole(idp, "user");
    const depot = word();
    const held = await searchedBrainOf(person.userId, depot);
    const { stub, chat, provider, ask } = await chatOf(
      person.userId,
      toolStep("searchBrain", { question: `depot ${depot}` }),
      says("Seven.")
    );
    // A question whose words hold nothing of the memory: the recall
    // before it hands none of it over.
    await ask("When can I drop the pallets off?");

    const [first, second] = provider.requests.map(({ body }) =>
      JSON.stringify(body)
    );
    const [searched] = await toolResults(stub, chat.id);
    const found = searched?.text ?? "";
    expect({
      // The memory, which the recall before it didn't hand over.
      beforeTheSearch: first?.includes(held.memory),
      tool: searched?.tool,
      memory: found.includes(held.memory),
      own: found.includes(held.own),
      everyone: found.includes(held.everyone),
      // The model's next request carries what it found.
      handed: second?.includes(held.memory),
      marked: await stub.isChatPrivateRead(chat.id),
    }).toStrictEqual({
      beforeTheSearch: false,
      tool: "searchBrain",
      memory: true,
      own: true,
      everyone: true,
      handed: true,
      marked: true,
    });
    // One `brain.recall` event of its own, with what it read as and how
    // many it handed over, never what they say.
    const { detail } = await searchEventOf(stub, chat.id);
    expect({
      outcome: detail.outcome,
      reads: detail.reads,
      memories: detail.memories,
      versions: typeof detail.versions === "number" && detail.versions >= 2,
      says: JSON.stringify(detail).includes(depot),
    }).toStrictEqual({
      outcome: "ok",
      reads: "person",
      memories: 1,
      versions: true,
      says: false,
    });
    // What it found as the person counts as their use (`memoriesUsed`).
    const used = await stub.memoriesUsed(Date.now());
    expect(used.some(({ memory }) => memory === held.memoryId)).toBeTruthy();
  });

  it("records a search refused for a person suspended mid-turn in the audit log", async () => {
    const person = await signedInWithRole(idp, "user");
    const depot = word();
    await searchedBrainOf(person.userId, depot);
    const { stub, chat, ask } = await chatOf(person.userId);
    // Suspended as the model answers, before its search runs.
    await answeringProvider(async (requests) => {
      if (requests.length === 1) {
        await env.DB.prepare(
          "UPDATE members SET suspended_at = ?, suspended_by = 'directory' WHERE user_id = ?"
        )
          .bind(Date.now(), person.userId)
          .run();
        return toolStep("searchBrain", { question: `depot ${depot}` });
      }
      return says("Nothing.");
    });
    await outcome(ask("When can I drop the pallets off?"));

    const { detail } = await searchEventOf(stub, chat.id);
    expect({ outcome: detail.outcome, reads: detail.reads }).toStrictEqual({
      outcome: "refused",
      reads: "person",
    });
  });

  it("marks the chat when it alone hands over something of the person's own", async () => {
    const person = await signedInWithRole(idp, "user");
    const depot = word();
    // Nothing of theirs the recall before the question can find: their
    // memory alone, which only the search finds by its words.
    await searchedBrainOf(person.userId, depot, { ownDocument: false });
    const { stub, chat, ask } = await chatOf(
      person.userId,
      says("Let me look."),
      toolStep("searchBrain", { question: `depot ${depot}` }),
      says("Seven.")
    );
    await ask("When can I drop the pallets off?");
    const beforeTheSearch = await stub.isChatPrivateRead(chat.id);
    await ask("Look it up, please.");

    expect({
      beforeTheSearch,
      afterIt: await stub.isChatPrivateRead(chat.id),
    }).toStrictEqual({ beforeTheSearch: false, afterIt: true });
  });

  it("finds only what everyone may read in a turn nobody started", async () => {
    const person = await signedInWithRole(idp, "user");
    const depot = word();
    const held = await searchedBrainOf(person.userId, depot);
    const { stub, chat } = await chatOf(
      person.userId,
      toolStep("searchBrain", { question: `depot ${depot}` }),
      says("Seven.")
    );
    await stub.askUnattended(chat.id, {
      text: "When can the pallets go?",
      model,
    });

    const [searched] = await toolResults(stub, chat.id);
    const found = searched?.text ?? "";
    expect({
      memory: found.includes(held.memory),
      own: found.includes(held.own),
      everyone: found.includes(held.everyone),
      marked: await stub.isChatPrivateRead(chat.id),
    }).toStrictEqual({
      memory: false,
      own: false,
      everyone: true,
      marked: false,
    });
  });

  it("withholds what it found from every later request once a memory of it is forgotten", async () => {
    const person = await signedInWithRole(idp, "user");
    const depot = word();
    const held = await searchedBrainOf(person.userId, depot);
    const { provider, ask } = await chatOf(
      person.userId,
      toolStep("searchBrain", { question: `depot ${depot}` }),
      says("Seven."),
      says("Noted.")
    );
    await ask("When can I drop the pallets off?");
    await forgetAs(env, person.userId, held.memoryId);
    const before = provider.requests.length;
    await ask("Thanks.");

    const next = JSON.stringify(provider.requests[before]?.body);
    expect({
      memory: next.includes(held.memory),
      withheld: next.includes(withheldResult),
    }).toStrictEqual({ memory: false, withheld: true });
  });
});

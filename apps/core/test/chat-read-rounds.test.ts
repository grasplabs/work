import { agentErrors } from "@grasp-os/shared/agent";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { inJurisdiction } from "../src/durable-objects.ts";
import { pausedReply, says, toolResults } from "./agent-chat.ts";
import { chatsWith, revokedRow, runRecords } from "./agent-code-runs.ts";
import { mockIdp } from "./idp.ts";
import type {
  Answer,
  FakeProvider,
  ScriptedToolCall,
} from "./model-provider.ts";

// A round of the chat's tool calls, through the Workspace and the chat's
// own object, all real but the model provider: reads alone run together,
// at most four at once, and come back in call order; any other call makes
// its round one call at a time; Stop ends every call of the round; and a
// permission revoked while they run withholds each, as it does one.

const idp = mockIdp();

const { newChat } = chatsWith(idp);

/** A search of the brain the model asks for. */
const search = (question: string): ScriptedToolCall => ({
  id: `call_${crypto.randomUUID()}`,
  name: "searchBrain",
  arguments: { question },
});

/** The model calls `calls` in one response, held until released. */
const round = (...calls: ScriptedToolCall[]) =>
  pausedReply(
    {
      text: "Looking.",
      toolCalls: calls,
      inputTokens: 200,
      outputTokens: 40,
    } satisfies Answer,
    1
  );

/**
 * Holds the brain's shared store, which every search reads, until the
 * returned release: a search waits there with its run open. Waited on by
 * flags: workerd won't let one request wait on another's promise.
 */
const holdBrain = async () => {
  const hold = { reached: false, released: false };
  const store = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
  const held = runInDurableObject(store, async (_instance, state) => {
    await state.blockConcurrencyWhile(async () => {
      hold.reached = true;
      while (!hold.released) {
        // oxlint-disable-next-line no-await-in-loop -- until the test says
        await scheduler.wait(20);
      }
    });
  });
  await vi.waitFor(() => {
    expect(hold.reached).toBeTruthy();
  });
  return async () => {
    hold.released = true;
    await held;
  };
};

/** How each of the model's own calls' runs stands, oldest first. */
const runsOf = async (
  stub: Parameters<typeof runRecords>[0],
  chatId: string
) => {
  const records = await runRecords(stub, chatId);
  return records.map(({ tool_call_id, status }) => ({
    call: tool_call_id,
    status,
  }));
};

/** How each of the model's own calls' runs stands, oldest first: its status. */
const statusesOf = async (
  stub: Parameters<typeof runRecords>[0],
  chatId: string
) => {
  const runs = await runsOf(stub, chatId);
  return runs.map(({ status }) => status);
};

/**
 * Sends the round once the question's recall is done (it reads the brain
 * too), with the brain held: each search of the round waits there.
 */
const roundHeld = async (
  provider: FakeProvider,
  { release }: ReturnType<typeof round>
) => {
  await vi.waitFor(
    () => {
      expect(provider.requests).toHaveLength(1);
    },
    { timeout: 10_000 }
  );
  const releaseBrain = await holdBrain();
  release();
  return releaseBrain;
};

/** The call IDs of the results a request to the model carried, in order. */
const resultsSent = (provider: FakeProvider, at: number): string[] =>
  [
    ...JSON.stringify(provider.requests[at]?.body).matchAll(
      /"tool_use_id":"(?<id>[^"]+)"/gu
    ),
  ].flatMap(({ groups }) =>
    groups?.id === undefined || groups.id.startsWith("recall_")
      ? []
      : [groups.id]
  );

describe("a round of the chat's tool calls", () => {
  it("runs reads together, at most four at once, and hands the model their results in call order", async () => {
    const calls = ["fees", "rates", "terms", "staff", "rooms"].map(search);
    const reads = round(...calls);
    const { stub, chat, provider, ask } = await newChat(
      reads.reply,
      says("Found.")
    );

    const reply = ask("What do we charge?");
    const releaseBrain = await roundHeld(provider, reads);
    let whileHeld: unknown[];
    try {
      // Four searches have opened their runs and wait at the brain; the
      // fifth waits for one of them to end before it opens its own.
      await vi.waitFor(
        async () => {
          await expect(runsOf(stub, chat.id)).resolves.toHaveLength(4);
        },
        { timeout: 10_000 }
      );
      await scheduler.wait(300);
      whileHeld = await statusesOf(stub, chat.id);
    } finally {
      await releaseBrain();
    }

    await expect(reply).resolves.toMatchObject({
      outcome: "answered",
      answer: "Found.",
    });
    const ids = calls.map(({ id }) => id);
    const runs = await runsOf(stub, chat.id);
    expect({
      whileHeld,
      runs: runs.map(({ status }) => status),
      ran: new Set(runs.map(({ call }) => call)),
      sent: resultsSent(provider, 1),
    }).toStrictEqual({
      whileHeld: Array.from({ length: 4 }, () => "running"),
      runs: Array.from({ length: 5 }, () => "completed"),
      ran: new Set(ids),
      sent: ids,
    });
  });

  it("runs a round with a call that isn't a read one call at a time, in call order", async () => {
    const first = search("fees");
    const code = {
      id: `call_${crypto.randomUUID()}`,
      name: "executeCode",
      arguments: { code: "export default async () => 42;" },
    };
    const last = search("terms");
    const reads = round(first, code, last);
    const { stub, chat, provider, ask } = await newChat(
      reads.reply,
      says("Done.")
    );

    const reply = ask("Look, then count.");
    const releaseBrain = await roundHeld(provider, reads);
    let whileHeld: Awaited<ReturnType<typeof runsOf>>;
    try {
      await vi.waitFor(
        async () => {
          await expect(runsOf(stub, chat.id)).resolves.toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // Time enough for the others to start, were they to run beside it.
      await scheduler.wait(300);
      whileHeld = await runsOf(stub, chat.id);
    } finally {
      await releaseBrain();
    }

    await expect(reply).resolves.toMatchObject({ outcome: "answered" });
    expect({
      whileHeld,
      runs: await runsOf(stub, chat.id),
      sent: resultsSent(provider, 1),
    }).toStrictEqual({
      whileHeld: [{ call: first.id, status: "running" }],
      runs: [first, code, last].map(({ id }) => ({
        call: id,
        status: "completed",
      })),
      sent: [first.id, code.id, last.id],
    });
  });

  it("ends every call of a round of reads when the person stops it, those waiting for a slot too", async () => {
    const calls = ["fees", "rates", "terms", "staff", "rooms"].map(search);
    const reads = round(...calls);
    const { stub, chat, personId, provider, ask } = await newChat(reads.reply);

    const reply = ask("What do we charge?");
    const releaseBrain = await roundHeld(provider, reads);
    let stopped: Promise<unknown> | undefined;
    try {
      await vi.waitFor(
        async () => {
          await expect(runsOf(stub, chat.id)).resolves.toHaveLength(4);
        },
        { timeout: 10_000 }
      );
      // Answered once the stopped calls have returned: those at the brain
      // return once it answers again.
      stopped = stub.cancel(chat.id, personId);
      // Each call ends as the turn stops, the brain still held: its run
      // closes, and pi keeps its result.
      await vi.waitFor(
        async () => {
          await expect(statusesOf(stub, chat.id)).resolves.toStrictEqual(
            Array.from({ length: 4 }, () => "cancelled")
          );
          await expect(toolResults(stub, chat.id)).resolves.toHaveLength(5);
        },
        { timeout: 10_000 }
      );
    } finally {
      await releaseBrain();
    }

    await expect(stopped).resolves.toBeTruthy();
    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    expect({
      results: await toolResults(stub, chat.id),
      // The fifth never opened a run.
      runs: await statusesOf(stub, chat.id),
      // No request after the stopped round.
      requests: provider.requests.length,
    }).toStrictEqual({
      results: calls.map(() => ({
        tool: "searchBrain",
        isError: true,
        text: "Tool searchBrain was aborted",
      })),
      runs: Array.from({ length: 4 }, () => "cancelled"),
      requests: 1,
    });
  });

  it("withholds every read of a round once a permission of its agent was revoked while they ran", async () => {
    const calls = ["fees", "rates", "terms"].map(search);
    const reads = round(...calls);
    const { stub, chat, agent, provider, ask } = await newChat(
      reads.reply,
      says("Done.")
    );

    const reply = ask("What do we charge?");
    const releaseBrain = await roundHeld(provider, reads);
    try {
      await vi.waitFor(
        async () => {
          await expect(runsOf(stub, chat.id)).resolves.toHaveLength(3);
        },
        { timeout: 10_000 }
      );
      await revokedRow(agent.agentId, { granted: true, chatId: null });
    } finally {
      await releaseBrain();
    }

    await reply;
    expect({
      results: await toolResults(stub, chat.id),
      runs: await statusesOf(stub, chat.id),
    }).toStrictEqual({
      results: calls.map(() => ({
        tool: "searchBrain",
        isError: true,
        text: JSON.stringify({
          status: "revoked",
          error: agentErrors.create("agent.run_revoked").message,
        }),
      })),
      runs: ["revoked", "revoked", "revoked"],
    });
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import { chatTurnPurpose } from "../src/model-spend.ts";
import { chatOf, codeStep, model, pausedReply, says } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { turnRecordsOf } from "./model-usage.ts";
import { signedInWithRole } from "./sign-in.ts";

// One record per chat turn (src/turn-records.ts), written as the turn
// settles in its chat's object, through the Workspace's own `ask`: the
// model gateway, connect and pi are real, the provider behind connect is
// the fake (test/model-provider.ts).

const idp = mockIdp();

/**
 * What the gateway's `model.call` audit events of `chatId`'s turns say
 * they used: what a turn's record sums.
 */
const chargedIn = async (chatId: string) => {
  const events = await allEvents();
  const calls = events.filter(
    ({ action, detail }) =>
      action === "model.call" &&
      detail.chat === chatId &&
      detail.purpose === chatTurnPurpose
  );
  return {
    inputTokens: calls.reduce(
      (sum, { model: used }) => sum + (used?.inputTokens ?? 0),
      0
    ),
    outputTokens: calls.reduce(
      (sum, { model: used }) => sum + (used?.outputTokens ?? 0),
      0
    ),
    cacheReadTokens: calls.reduce(
      (sum, { detail }) => sum + Number(detail.cacheReadTokens),
      0
    ),
    micros: Math.round(
      calls.reduce((sum, { cost }) => sum + (cost?.amount ?? 0), 0) * 1e6
    ),
  };
};

describe("a chat turn's record", () => {
  it("records an answered turn once: its times in order, what it used as the gateway charged it, its tools and how it ended", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { ask, chat } = await chatOf(userId, codeStep("return 1 + 1;"), {
      ...says("It is two."),
      cache: { read: 150, write: 20 },
    });
    await expect(ask("What is one and one?")).resolves.toMatchObject({
      outcome: "answered",
    });
    const turns = await turnRecordsOf(chat.id, 1);
    const charged = await chargedIn(chat.id);
    expect(
      turns.map((turn) => ({
        chatId: turn.chatId,
        surface: turn.surface,
        model: turn.model,
        effort: turn.effort,
        outcome: turn.outcome,
        code: turn.code,
        stopReason: turn.stopReason,
        tools: Object.entries(turn.tools).map(([name, { calls }]) => ({
          name,
          calls,
        })),
        retries: turn.retries,
        fallbacks: turn.fallbacks,
        rateLimitWaits: turn.rateLimitWaits,
        compacted: turn.compacted,
        resumed: turn.resumed,
        used: {
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          micros: Math.round(turn.cost * 1e6),
        },
        // From the question's arrival: its first request, its first
        // token, its first words shown, then its end, in that order.
        times: [
          turn.firstRequestMs,
          turn.firstTokenMs,
          turn.firstTextMs,
          turn.doneMs,
        ].map(
          (ms, at, all) =>
            ms !== null &&
            all.slice(0, at).every((before) => (before ?? Infinity) <= ms)
        ),
      }))
    ).toStrictEqual([
      {
        chatId: chat.id,
        surface: "web",
        model,
        effort: null,
        outcome: "answered",
        code: null,
        stopReason: "stop",
        tools: [{ name: "executeCode", calls: 1 }],
        retries: 0,
        fallbacks: 0,
        rateLimitWaits: 0,
        compacted: false,
        resumed: false,
        // Both responses, the code step's and the answer's, as the
        // gateway's audit events say.
        used: charged,
        times: [true, true, true, true],
      },
    ]);
    expect(charged.cacheReadTokens).toBe(150);
  });

  it("records a failed turn with the gateway's code, its first request but no token", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { ask, chat } = await chatOf(userId, { status: 500 });
    await expect(ask("Anyone there?")).resolves.toMatchObject({
      outcome: "failed",
    });
    const [turn] = await turnRecordsOf(chat.id, 1);
    expect({
      outcome: turn?.outcome,
      code: turn?.code,
      stopReason: turn?.stopReason,
      requested: typeof turn?.firstRequestMs,
      firstTokenMs: turn?.firstTokenMs,
      firstTextMs: turn?.firstTextMs,
      outputTokens: turn?.outputTokens,
      tools: turn?.tools,
    }).toStrictEqual({
      outcome: "failed",
      code: "model.provider_unavailable",
      stopReason: "error",
      requested: "number",
      firstTokenMs: null,
      firstTextMs: null,
      outputTokens: 0,
      tools: {},
    });
  });

  it("records a turn its person stopped mid-answer as cancelled, the answer cut off", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const held = pausedReply(says("A long answer, cut off here."), 6);
    const { ask, chat, provider, stub } = await chatOf(userId, held.reply);
    try {
      const answer = ask("Tell me everything.");
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      await stub.cancel(chat.id, userId);
      await expect(answer).resolves.toMatchObject({ outcome: "cancelled" });
    } finally {
      held.release();
    }
    const [turn] = await turnRecordsOf(chat.id, 1);
    expect({
      outcome: turn?.outcome,
      code: turn?.code,
      stopReason: turn?.stopReason,
      requested: typeof turn?.firstRequestMs,
    }).toStrictEqual({
      outcome: "cancelled",
      code: null,
      stopReason: "aborted",
      requested: "number",
    });
  });

  it("counts a rate limit the gateway waited out, and how long", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { ask, chat } = await chatOf(
      userId,
      { status: 429, headers: { "retry-after": "1" } },
      says("Now I can.")
    );
    await expect(ask("Can you answer?")).resolves.toMatchObject({
      outcome: "answered",
    });
    const [turn] = await turnRecordsOf(chat.id, 1);
    expect({
      rateLimitWaits: turn?.rateLimitWaits,
      waitedASecond: (turn?.rateLimitWaitMs ?? 0) >= 900,
      retries: turn?.retries,
      fallbacks: turn?.fallbacks,
      outcome: turn?.outcome,
    }).toStrictEqual({
      rateLimitWaits: 1,
      waitedASecond: true,
      retries: 0,
      fallbacks: 0,
      outcome: "answered",
    });
  });
});

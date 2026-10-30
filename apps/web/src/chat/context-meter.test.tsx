// @vitest-environment happy-dom
import type { ChatMessage, ChatReplyUsage } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ContextMeter, contextOf } from "./context-meter.tsx";

// The chat's context meter, from the usage core keeps on each reply: how
// full the model's window was at the latest reply, what that reply wrote
// and cost, and what the chat cost so far; the window left out when core
// doesn't know it, and nothing before any reply counted its usage.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const usage = (changes: Partial<ChatReplyUsage> = {}): ChatReplyUsage => ({
  input: 1000,
  output: 200,
  cacheRead: 3000,
  cacheWrite: 0,
  cost: 0.01,
  contextWindow: 200_000,
  ...changes,
});

const question = (id: number): ChatMessage => ({
  id,
  role: "user",
  text: "What's due this week?",
  at: "2026-10-30T10:00:00.000Z",
});

const reply = (id: number, used?: ChatReplyUsage): ChatMessage => ({
  id,
  role: "assistant",
  text: "Three invoices.",
  citations: [],
  code: [],
  end: "done",
  ...(used === undefined ? {} : { usage: used }),
  at: "2026-10-30T10:00:01.000Z",
});

/**
 * What the meter says for `messages`, line by line: its lines' text,
 * never the progress bar's own hidden markup.
 */
const shown = async (messages: readonly ChatMessage[]): Promise<string[]> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <ContextMeter messages={messages} />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return [...host.querySelectorAll("p")].map((line) => line.textContent);
};

describe(contextOf, () => {
  it("fills the window with the latest reply's prompt, cached or not, and adds up the chat's cost", () => {
    expect(
      contextOf([
        question(1),
        reply(2, usage({ cost: 0.02 })),
        question(3),
        // Core's own words after a restart: no model wrote them, nothing counted.
        reply(4),
        reply(5, usage({ input: 500, cacheRead: 9000, cacheWrite: 500 })),
      ])
    ).toStrictEqual({
      used: 10_000,
      window: 200_000,
      written: 200,
      cost: 0.01,
      total: 0.03,
    });
  });

  it("is nothing before any reply counted its usage", () => {
    expect(contextOf([question(1), reply(2)])).toBeUndefined();
  });
});

describe(ContextMeter, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says how full the window is, and what the latest reply and the chat cost", async () => {
    const text = await shown([
      reply(1, usage({ cost: 0.02 })),
      reply(2, usage({ input: 46_000, cacheRead: 4000 })),
    ]);
    const meter = document.querySelector('[role="progressbar"]');

    expect({
      text,
      label: meter?.getAttribute("aria-label"),
      value: meter?.getAttribute("aria-valuenow"),
    }).toStrictEqual({
      text: [
        "50,000 of 200,000 tokens of the model's context window (25%)",
        "The latest reply wrote 200 tokens and cost $0.01. This chat so far: $0.03.",
      ],
      label: "Context window",
      value: "25",
    });
  });

  it("leaves the window out when core doesn't know it", async () => {
    await expect(
      shown([reply(1, usage({ contextWindow: null }))])
    ).resolves.toStrictEqual([
      "The latest reply was sent 4,000 tokens. The model's context window isn't known.",
      "The latest reply wrote 200 tokens and cost $0.01. This chat so far: $0.01.",
    ]);
  });

  it("shows nothing before any reply counted its usage", async () => {
    await expect(shown([question(1), reply(2)])).resolves.toStrictEqual([]);
  });
});

// @vitest-environment happy-dom
import type { ChatAgent } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentName, AgentPicker, startingAgent } from "./agent-choice.tsx";

// Which agent answers, in the box to ask in. These start from the ways it
// can fail: a person with one agent shown a choice they don't have; a new
// chat started with an agent that isn't theirs any more; an open chat
// naming another agent than its own, or one the person may no longer see.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const stephen: ChatAgent = {
  id: "organization",
  name: "Stephen",
  face: "stephen",
  job: "Answers from what the company told Grasp.",
  model: null,
  own: false,
};
const claire: ChatAgent = {
  id: "agent-claire",
  name: "Claire",
  face: "claire",
  job: "Chases unpaid invoices.",
  model: null,
  own: false,
};

let root: Root | undefined;

/** `node` on the page. */
const shown = async (node: ReactNode): Promise<HTMLElement> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
    await Promise.resolve();
  });
  return host;
};

const noPick = (): void => {
  // Nothing is picked in these.
};

describe("which agent answers, in the box to ask in", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("starts a new chat with the first agent until another of the person's is picked", () => {
    expect(startingAgent([stephen, claire])).toBe(stephen);
    expect(startingAgent([stephen, claire], claire.id)).toBe(claire);
    // Picked, then taken from the person: the first one again.
    expect(startingAgent([stephen], claire.id)).toBe(stephen);
    expect(startingAgent([], claire.id)).toBeUndefined();
  });

  it("offers no choice to a person with one agent, or none", async () => {
    const one = await shown(
      <AgentPicker agentId={undefined} agents={[stephen]} onAgent={noPick} />
    );
    expect(one.textContent).toBe("");
    const none = await shown(
      <AgentPicker agentId={undefined} agents={[]} onAgent={noPick} />
    );
    expect(none.textContent).toBe("");
  });

  it("names the agent that will answer on the control that changes it", async () => {
    const host = await shown(
      <AgentPicker
        agentId={claire.id}
        agents={[stephen, claire]}
        onAgent={noPick}
      />
    );
    const control = host.querySelector("button");
    expect(control?.textContent).toBe("Claire");
    expect(control?.getAttribute("aria-label")).toBe(
      "Claire answers. Change agent"
    );
  });

  it("names the agent an open chat is with, and nothing for one that isn't the person's", async () => {
    const hers = await shown(
      <AgentName agentId={claire.id} agents={[stephen, claire]} />
    );
    expect(hers.textContent).toBe("Claire");
    expect(hers.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
      "Claire answers in this chat"
    );
    const gone = await shown(
      <AgentName agentId="agent-gone" agents={[stephen, claire]} />
    );
    expect(gone.textContent).toBe("");
    const alone = await shown(
      <AgentName agentId={stephen.id} agents={[stephen]} />
    );
    expect(alone.textContent).toBe("");
  });
});

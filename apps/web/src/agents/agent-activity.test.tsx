// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentActivity } from "./agent-activity.tsx";
import type { ActivityStep } from "./agent-activity.tsx";

// What an agent did, in one line: it must count what the steps that ran
// did, never a step still waiting, and never pass a failed step off as
// done. While the agent works, the line says what it is doing instead.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const lineOf = async (
  steps: readonly ActivityStep[],
  working = false
): Promise<string> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AgentActivity
          steps={steps}
          working={working}
          workingLabel="Reading your files…"
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return (
    host.querySelector("[aria-expanded]")?.textContent?.trim() ??
    host.textContent.trim()
  );
};

const step = (change: Partial<ActivityStep>): ActivityStep => ({
  id: crypto.randomUUID(),
  kind: "read",
  title: "Read brief.md",
  state: "done",
  ...change,
});

describe("what an agent did", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("counts what the steps that ran touched, the sources found first", async () => {
    await expect(
      lineOf([
        step({ kind: "search", title: "Searched the web", count: 12 }),
        step({ count: 2 }),
        step({ kind: "write", title: "Changed plan.md" }),
        step({ kind: "tool", title: "Opened the CRM", state: "waiting" }),
      ])
    ).resolves.toContain("Found 12 sources, read 2 files, and changed 1 file");
  });

  it("counts searches that say nothing of what they found as searches", async () => {
    await expect(
      lineOf([
        step({ kind: "search", title: "Searched the web" }),
        step({ kind: "search", title: "Searched the web again" }),
      ])
    ).resolves.toContain("Searched 2 times");
  });

  it("says how many steps failed", async () => {
    await expect(
      lineOf([step({}), step({ title: "Read plan.md", state: "failed" })])
    ).resolves.toContain("Read 2 files; 1 step failed");
  });

  it("says what it is doing while it works, not what it has done", async () => {
    const line = await lineOf([step({})], true);
    expect({
      working: line.includes("Reading your files…"),
      counted: line.includes("Read 1 file"),
    }).toStrictEqual({ working: true, counted: false });
  });
});

// @vitest-environment happy-dom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { wordsOf } from "../test-words.ts";
import { FrameFailure } from "./frame-failure.tsx";
import type { PageState } from "./page-host.ts";

// What an App's frame shows once its page failed: the frame's failed page,
// headed under the App's own heading, saying why, with Try again and, for
// a preview its draft broke, Fix with Grasp; no way to Chat, as the App's
// bar stands around it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const shown = (
  state: Extract<PageState, { status: "failed" | "signed-out" }>,
  preview: boolean,
  onFix?: () => void
) => {
  const retries = { count: 0 };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <I18nProvider i18n={i18n}>
        <FrameFailure
          onFix={onFix}
          onRetry={() => {
            retries.count += 1;
          }}
          preview={preview}
          state={state}
        />
      </I18nProvider>
    );
  });
  return { host, retries };
};

const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find(
    (element) => wordsOf(element) === name
  );

describe("an App's frame whose page failed", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says what happened under the App's heading, and tries again", () => {
    const { host, retries } = shown(
      { status: "failed", reason: "timed-out" },
      false
    );
    expect(host.querySelector("h2")?.textContent).toBe(
      "This page didn't start"
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "It took too long to start"
    );
    expect(button(host, "Go to Chat")).toBeUndefined();
    act(() => {
      button(host, "Try again")?.click();
    });
    expect(retries.count).toBe(1);
  });

  it("offers Fix with Grasp for a preview its draft broke, and the details folded", () => {
    const fixes = { count: 0 };
    const { host } = shown(
      { status: "failed", reason: "broken", detail: "SyntaxError" },
      true,
      () => {
        fixes.count += 1;
      }
    );
    expect(host.querySelector("h2")?.textContent).toBe(
      "The preview didn't start"
    );
    expect(host.textContent).toContain("The draft's code doesn't build.");
    expect(button(host, "Technical details")).toBeDefined();
    act(() => {
      button(host, "Fix with Grasp")?.click();
    });
    expect(fixes.count).toBe(1);
  });

  it("offers no fix where the draft did not cause it", () => {
    const { host } = shown(
      { status: "failed", reason: "forbidden" },
      true,
      () => {
        // Never offered here.
      }
    );
    expect(host.querySelector("h2")?.textContent).toBe(
      "You can't open this App"
    );
    expect(button(host, "Fix with Grasp")).toBeUndefined();
  });
});

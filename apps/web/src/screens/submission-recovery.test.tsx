// @vitest-environment happy-dom
import type { ScreenSubmission } from "@grasp-os/shared/submissions";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SubmissionRecovery } from "./submission-recovery.tsx";

// Above an App's screen, the person's submissions whose answer the page
// may never have shown, against core's screen submissions as the page
// reaches them over RPC (the boundary from the web app), faked: it keeps
// the person's submissions and forgets one when it is dismissed.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const submission = (
  id: string,
  app: string,
  status: ScreenSubmission["status"],
  failure: string | null = null
): ScreenSubmission => ({
  id,
  app,
  kind: "mutation",
  operation: `orders.${id}`,
  status,
  failure,
  createdAt: "2026-10-30T09:00:00.000Z",
});

/** Core's screen submissions for the signed-in person, and each dismissal. */
const fakeSubmissions = (kept: ScreenSubmission[] | Error) => {
  const dismissed: string[] = [];
  let held = kept;
  const screenSubmissions = {
    list: async (): Promise<ScreenSubmission[]> => {
      await Promise.resolve();
      if (held instanceof Error) {
        throw held;
      }
      return held;
    },
    dismiss: async (id: string): Promise<void> => {
      await Promise.resolve();
      dismissed.push(id);
      if (!(held instanceof Error)) {
        held = held.filter((each) => each.id !== id);
      }
    },
  };
  return { session: { screenSubmissions }, dismissed };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The recovery above `app`'s screen, on what `session` holds. */
const shown = async (
  session: ReturnType<typeof fakeSubmissions>["session"],
  app: string
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <SubmissionRecovery app={app} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
};

/** The operations listed, in order. */
const listed = (): string[] =>
  [...document.querySelectorAll("li code")].map(
    (each) => each.textContent ?? ""
  );

const text = (): string => document.body.textContent ?? "";

describe("Recovering a screen's submissions", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows this App's submissions with how each came out, and forgets one once dismissed", async () => {
    const { session, dismissed } = fakeSubmissions([
      submission("a", "orders", "uncertain"),
      submission("b", "orders", "failed", "timeout"),
      submission("c", "invoices", "saved"),
    ]);
    await shown(session, "orders");
    const before = listed();
    expect(text()).toContain("Whether it went through can’t be told.");
    expect(text()).toContain("It failed. Reason: timeout.");

    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Dismiss orders.a"]'
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    await settled();

    expect({ before, dismissed, after: listed() }).toStrictEqual({
      before: ["orders.a", "orders.b"],
      dismissed: ["a"],
      after: ["orders.b"],
    });
  });

  it("shows nothing when there is nothing to recover for this App", async () => {
    const { session } = fakeSubmissions([submission("c", "invoices", "saved")]);
    await shown(session, "orders");

    expect(text()).toBe("");
  });

  it("keeps out of the way of the screen when core can't say", async () => {
    const { session } = fakeSubmissions(new Error("Core is restarting."));
    await shown(session, "orders");

    expect(text()).toBe("");
  });
});

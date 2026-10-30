// @vitest-environment happy-dom
import type { ChainBreak, ChainVerification } from "@grasp-os/shared/audit-log";
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

import { AuditChainCheck } from "./audit-chain.tsx";

// Settings › Audit trail › Chain check against core's audit log as the
// page reaches it over RPC (the boundary from the web app), faked: a chain
// of `head` entries, checked `stretch` at a time from the position asked,
// that breaks where it is told to.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Core's audit log, with each position a step was asked from. */
const fakeAudit = ({
  head,
  stretch,
  broken,
}: {
  head: number;
  stretch: number;
  broken?: { at: number; reason: ChainBreak };
}) => {
  const asked: number[] = [];
  const audit = {
    verify: async (after = 0): Promise<ChainVerification> => {
      await Promise.resolve();
      asked.push(after);
      const through = Math.min(after + stretch, head);
      if (broken !== undefined && broken.at > after && broken.at <= through) {
        return { ok: false, brokenAt: broken.at, reason: broken.reason };
      }
      return { ok: true, through, head: "h", done: through >= head };
    },
  };
  return { session: { audit }, asked };
};

let root: Root | undefined;

const shown = async (
  session: ReturnType<typeof fakeAudit>["session"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({ component: AuditChainCheck });
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
};

/** Presses "Verify now" and lets the whole pass run. */
const verify = async () => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === "Verify now"
  );
  if (button === undefined) {
    throw new TypeError("No Verify now");
  }
  await act(async () => {
    button.click();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const text = (): string => document.body.textContent ?? "";

describe("Settings › Audit trail › Chain check", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("verifies the whole chain a stretch at a time, from the first entry to the head", async () => {
    const { session, asked } = fakeAudit({ head: 250, stretch: 100 });
    await shown(session);
    expect(text()).toContain("Not verified since this page opened.");

    await verify();

    expect(asked).toStrictEqual([0, 100, 200]);
    expect(text()).toContain("The whole chain verified, through entry 250");
  });

  it("names the first entry where the chain breaks, and why, and checks nothing after it", async () => {
    const { session, asked } = fakeAudit({
      head: 250,
      stretch: 100,
      broken: { at: 142, reason: "altered" },
    });
    await shown(session);

    await verify();

    expect(asked).toStrictEqual([0, 100]);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The chain breaks at entry 142: nothing from there on is verified. An entry was changed after it was written."
    );
  });

  it("says an empty log has nothing to verify", async () => {
    const { session, asked } = fakeAudit({ head: 0, stretch: 100 });
    await shown(session);

    await verify();

    expect(asked).toStrictEqual([0]);
    expect(text()).toContain(
      "The audit trail has no entries yet: there is nothing to verify."
    );
  });
});

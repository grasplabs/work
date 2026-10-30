// @vitest-environment happy-dom
import type {
  ChainBreak,
  ChainVerification,
  FullVerification,
} from "@grasp-os/shared/audit-log";
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

import type { Loaded } from "../load-from-core.tsx";
import { AuditChainCheck } from "./audit-chain.tsx";

// Settings › Audit trail › Chain check against core's audit log as the
// page reaches it over RPC (the boundary from the web app), faked: a chain
// of `head` entries, checked `stretch` at a time from the position asked,
// that breaks where it is told to, and that keeps the last pass to run
// from the first entry and end, as core does.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const earlier: FullVerification = {
  ok: true,
  through: 120,
  head: "h120",
  startedAt: "2026-10-01T09:00:00.000Z",
  finishedAt: "2026-10-01T09:00:02.000Z",
};

/** Core's audit log, with each position a step was asked from. */
const fakeAudit = ({
  head,
  stretch,
  broken,
  last = null,
}: {
  head: number;
  stretch: number;
  broken?: { at: number; reason: ChainBreak };
  last?: FullVerification | null;
}) => {
  const asked: number[] = [];
  let kept = last;
  const keep = (pass: FullVerification) => {
    if (asked[0] === 0) {
      kept = pass;
    }
  };
  const audit = {
    verify: async (after = 0): Promise<ChainVerification> => {
      await Promise.resolve();
      asked.push(after);
      const at = new Date().toISOString();
      const through = Math.min(after + stretch, head);
      if (broken !== undefined && broken.at > after && broken.at <= through) {
        keep({
          ok: false,
          brokenAt: broken.at,
          reason: broken.reason,
          startedAt: at,
          finishedAt: at,
        });
        return { ok: false, brokenAt: broken.at, reason: broken.reason };
      }
      const done = through >= head;
      if (done) {
        keep({ ok: true, through, head: "h", startedAt: at, finishedAt: at });
      }
      return { ok: true, through, head: "h", done };
    },
    lastVerification: async (): Promise<FullVerification | null> => {
      await Promise.resolve();
      return kept;
    },
  };
  return { session: { audit }, asked };
};

let root: Root | undefined;

/** The section, on the last pass core kept, or on why it couldn't be read. */
const shown = async (
  session: ReturnType<typeof fakeAudit>["session"],
  refused?: string
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({
    loader: async (): Promise<Loaded<FullVerification | null>> =>
      refused === undefined
        ? { state: "ready", data: await session.audit.lastVerification() }
        : { state: "refused", message: refused },
    component: () => <AuditChainCheck last={rootRoute.useLoaderData()} />,
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

  it("shows the last full pass core kept, then verifies the whole chain a stretch at a time, from the first entry to the head", async () => {
    const { session, asked } = fakeAudit({
      head: 250,
      stretch: 100,
      last: earlier,
    });
    await shown(session);
    expect(text()).toContain("The whole chain verified, through entry 120");

    await verify();

    expect({
      asked,
      kept: await session.audit.lastVerification(),
    }).toMatchObject({
      asked: [0, 100, 200],
      kept: { ok: true, through: 250 },
    });
    expect(text()).toContain("The whole chain verified, through entry 250");
  });

  it("says when the chain was never verified", async () => {
    const { session } = fakeAudit({ head: 250, stretch: 100 });
    await shown(session);

    expect(text()).toContain("The whole chain has not been verified yet.");
  });

  it("names the first entry where the chain breaks, and why, and checks nothing after it", async () => {
    const { session, asked } = fakeAudit({
      head: 250,
      stretch: 100,
      broken: { at: 142, reason: "altered" },
      last: earlier,
    });
    await shown(session);

    await verify();

    expect(asked).toStrictEqual([0, 100]);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /the chain broke at entry 142: nothing from there on is verified\. An entry was changed after it was written\.$/u
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

  it("says why the last pass couldn't be read, and still verifies", async () => {
    const { session } = fakeAudit({ head: 50, stretch: 100 });
    await shown(session, "Only an admin of the organization can do this.");
    expect(text()).toContain("Only an admin of the organization can do this.");

    await verify();

    expect(text()).toContain("The whole chain verified, through entry 50");
  });
});

// @vitest-environment happy-dom
import type { AppErrorEntry, AppErrorLog } from "@grasp-os/shared/screens";
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

import { AppErrors } from "./app-errors.tsx";

// A domain's error log on its Errors tab, against core's screens as the
// page reaches them over RPC (the boundary from the web app), faked: it
// gives the log as it holds it when asked, and refuses anyone who doesn't
// build the App, as core does.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const crashed: AppErrorEntry = {
  source: "screen",
  kind: "error",
  message: "Cannot read properties of undefined (reading 'total')",
  stack: "TypeError: Cannot read properties of undefined\n    at Invoice",
  at: "2026-10-30T09:15:00.000Z",
  version: 3,
  screen: "invoice",
  count: 12,
};

const serverLine: AppErrorEntry = {
  source: "server",
  level: "warn",
  message: "Exchange rate missing for SEK",
  method: "convert",
  at: "2026-10-30T08:00:00.000Z",
  version: 3,
  count: 1,
};

/** Core's screens for one App: its error log, and how often it was read. */
const fakeScreens = (log: AppErrorLog | Error) => {
  let held = log;
  const asked: string[] = [];
  const screens = {
    errors: async (app: string): Promise<AppErrorLog> => {
      await Promise.resolve();
      asked.push(app);
      if (held instanceof Error) {
        throw held;
      }
      return held;
    },
  };
  return {
    session: { screens },
    asked,
    reports: (next: AppErrorLog) => {
      held = next;
    },
  };
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

const shown = async (
  session: ReturnType<typeof fakeScreens>["session"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <AppErrors app={{ id: "app-1" }} />,
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

const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (button === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

const text = (): string => document.body.textContent ?? "";

/** Each row of the log: its cells' text. */
const rows = (): string[][] =>
  [...document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")
  );

describe("A domain's error log, for its builders", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows each problem once, where it came from, in which version, how often and its stack", async () => {
    const { session, asked } = fakeScreens({
      entries: [crashed, serverLine],
      suppressed: 0,
    });
    await shown(session);

    const [screen, server] = rows();
    expect({
      asked,
      screen: screen?.slice(1, 4),
      server: server?.slice(1, 4),
      dropped: text().includes("dropped"),
    }).toStrictEqual({
      asked: ["app-1"],
      screen: ["invoice", "3", "12"],
      server: ["convert", "3", "1"],
      dropped: false,
    });
    expect(screen?.[0]).toMatch(/^Uncaught error.*at Invoice/su);
    expect(server?.[0]).toMatch(/^Server warning/u);
  });

  it("says how many reports were dropped when the app reported too many", async () => {
    const { session } = fakeScreens({ entries: [crashed], suppressed: 40 });
    await shown(session);

    expect(text()).toContain("At least 40 more reports were dropped");
  });

  it("says nothing went wrong when the log is empty", async () => {
    const { session } = fakeScreens({ entries: [], suppressed: 0 });
    await shown(session);

    expect(rows()).toStrictEqual([]);
    expect(text()).toContain("Nothing went wrong");
  });

  it("reads the log again on asking, with what was reported since", async () => {
    const { session, reports } = fakeScreens({ entries: [], suppressed: 0 });
    await shown(session);

    reports({ entries: [{ ...crashed, count: 13 }], suppressed: 0 });
    await press("Refresh");

    expect(rows()[0]?.[3]).toBe("13");
  });

  it("says why core refused", async () => {
    const { session } = fakeScreens(
      new Error("You don't have the role for this.")
    );
    await shown(session);

    expect(text()).toContain("You don't have the role for this.");
  });
});

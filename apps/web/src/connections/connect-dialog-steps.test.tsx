// @vitest-environment happy-dom
import type { Identity } from "@grasp-os/shared/rpc";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ConnectDialog } from "./connect-dialog.tsx";
import { integrationsOf } from "./integrations.ts";

// The connect dialog's steps against core's connections as the page
// reaches them over RPC, faked: where each step stands as the admin goes
// through them, and what "Try again" does while a start is still waiting.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const someone = (role: Identity["role"]): Identity => ({
  userId: "u1",
  email: "ada@example.com",
  name: "Ada",
  role,
  teams: [],
  staff: false,
  expiresAt: "2026-12-31T00:00:00.000Z",
});

const entry = (source: "native" | "composio", id: string, name: string) => ({
  source,
  id,
  name,
  categories: ["Productivity"],
  toolCount: 2,
  logo: null,
  description: null,
  group: "Other" as const,
  auth: "managed" as const,
  offered: true,
});

const [microsoft, hubspot] = integrationsOf(
  [
    entry("native", "microsoft", "Microsoft 365"),
    entry("composio", "hubspot", "HubSpot"),
  ],
  []
);

let root: Root | undefined;

/** A start core never answers. */
const waitingForever = async (): Promise<{ url: string }> =>
  await Promise.withResolvers<{ url: string }>().promise;

/** Lets pending promises and the renders they cause settle. */
const settled = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round lets the next settle
    await act(async () => {
      await Promise.resolve();
    });
  }
};

/** The dialog open on Microsoft 365, with core's `start` as given. */
const opened = async (
  identity: Identity,
  start: () => Promise<{ url: string }>,
  integration = microsoft
): Promise<void> => {
  if (integration === undefined) {
    throw new Error("No integration");
  }
  // A toolkit starts the same way, with its tools to choose from first.
  const connections = {
    start,
    connectToolkit: start,
    catalogTools: async () =>
      await Promise.resolve([
        {
          name: "HUBSPOT_LIST_CONTACTS",
          description: null,
          inputs: [],
          readOnly: true,
        },
      ]),
  };
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ConnectDialog
        identity={identity}
        integration={integration}
        onOpenChange={() => {
          // The test reads the dialog, not it closing.
        }}
        open
      />
    ),
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

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === text
  );

const press = async (
  element: HTMLElement | null | undefined
): Promise<void> => {
  if (element === null || element === undefined) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** What allows the toolkit's one tool: its row's label. */
const allow = (): HTMLElement | null | undefined =>
  [...document.querySelectorAll("li")]
    .find(
      (each) =>
        each.textContent?.includes("HUBSPOT_LIST_CONTACTS") &&
        each.querySelector("li") === null
    )
    ?.querySelector<HTMLElement>("label");

/** Where the step titled `title` stands. */
const stepState = (title: string): string | undefined =>
  [...document.querySelectorAll<HTMLElement>("li[data-state]")].find(
    (each) => each.querySelector("h3")?.textContent === title
  )?.dataset.state;

describe("the connect dialog's steps", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counts keeping the scope it starts with as choosing it", async () => {
    await opened(someone("admin"), async () => await waitingForever());
    expect([stepState("Who uses it"), stepState("Sign in")]).toStrictEqual([
      "active",
      "idle",
    ]);

    const preselected = document.querySelector<HTMLInputElement>(
      'input[type="radio"]:checked'
    );
    await press(preselected);
    expect([stepState("Who uses it"), stepState("Sign in")]).toStrictEqual([
      "done",
      "active",
    ]);
  });

  it("counts signing in with the scope it starts with as choosing it", async () => {
    await opened(someone("admin"), async () => await waitingForever());
    await press(button("Sign in to Microsoft 365"));
    expect([stepState("Who uses it"), stepState("Sign in")]).toStrictEqual([
      "done",
      "active",
    ]);
  });

  it("goes by the newest attempt only, when an older one answers after trying again failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {
        // The browser stays here for the test to read.
      });
    const first = Promise.withResolvers<{ url: string }>();
    const answers = [
      first.promise,
      Promise.reject(new Error("The second attempt failed")),
    ];
    // Caught here so the rejection waits for the dialog to take it.
    answers[1]?.catch(() => {
      // The dialog reports it.
    });
    let calls = 0;
    await opened(someone("user"), async () => {
      const answer = answers[calls];
      calls += 1;
      if (answer === undefined) {
        throw new Error("Started too often");
      }
      return await answer;
    });

    await press(button("Sign in to Microsoft 365"));
    expect(document.body.textContent).toContain("Waiting for Microsoft 365");
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    await press(button("Try again"));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Sign in to Microsoft 365")).toBeDefined();

    // The first attempt answers late: it neither sends the browser away
    // nor takes the failure's place.
    await act(async () => {
      first.resolve({ url: "https://login.example.test/start" });
      await Promise.resolve();
    });
    await settled();
    expect({
      sentAway: assign.mock.calls.length,
      failed: document.querySelector('[role="alert"]') !== null,
      waiting: document.body.textContent?.includes("Waiting for"),
      starts: calls,
    }).toStrictEqual({ sentAway: 0, failed: true, waiting: false, starts: 2 });
  });

  it("offers no retry once every tool of a toolkit is switched off while it waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let starts = 0;
    await opened(
      someone("admin"),
      async () => {
        starts += 1;
        return await waitingForever();
      },
      hubspot
    );
    await press(allow());
    await press(button("Consent and connect"));
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    await press(allow());
    await press(button("Try again"));
    expect({ disabled: button("Try again")?.disabled, starts }).toStrictEqual({
      disabled: true,
      starts: 1,
    });
  });

  it("starts the wait over with each attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await opened(someone("user"), async () => await waitingForever());
    await press(button("Sign in to Microsoft 365"));
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    await press(button("Try again"));
    expect(button("Try again")).toBeUndefined();
    expect(document.body.textContent).toContain("Waiting for Microsoft 365");
  });
});

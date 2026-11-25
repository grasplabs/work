// @vitest-environment happy-dom
import { composioKeyConsentText } from "@grasp-os/shared/connect";
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

// Someone who asked for less motion: the dialog stands still, and the test
// reads it without waiting on animations the test DOM can't run.
Reflect.set(window, "matchMedia", (query: string) => ({
  matches: query.includes("reduce"),
  media: query,
  onchange: null,
  addEventListener: () => {
    // Nothing changes during a test.
  },
  removeEventListener: () => {
    // Nothing to stop.
  },
  dispatchEvent: () => false,
}));

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

/**
 * The dialog open on Microsoft 365, with core's `start` as given, and any
 * other of core's connections methods as `more` has them.
 */
const opened = async (
  identity: Identity,
  start: () => Promise<{ url: string }>,
  integration = microsoft,
  more: Record<string, unknown> = {}
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
    ...more,
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
        // The tool HUBSPOT_LIST_CONTACTS, as it shows: "List contacts" in
        // HubSpot's dialog, with its toolkit's name before it in another's.

        // The tool HUBSPOT_LIST_CONTACTS, as it shows: "List contacts" in
        // HubSpot's dialog, with its toolkit's name before it in another's.
        each.textContent?.toLowerCase().includes("list contacts") &&
        each.querySelector("li") === null
    )
    ?.querySelector<HTMLElement>("label");

/** Types `value` into `input`, as someone typing does. */
const type = async (
  input: HTMLInputElement | null | undefined,
  value: string
): Promise<void> => {
  if (input === null || input === undefined) {
    throw new TypeError("Nothing to type into");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

/** The input labelled `label`. */
const field = (label: string): HTMLInputElement | null | undefined => {
  const id = [...document.querySelectorAll("label")]
    .find((each) => each.textContent === label)
    ?.getAttribute("for");
  return id === null || id === undefined
    ? undefined
    : document.querySelector<HTMLInputElement>(`[id="${id}"]`);
};

/** Where the step titled `title` stands. */
const stepState = (title: string): string | undefined =>
  [...document.querySelectorAll<HTMLElement>("section[data-state]")].find(
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

    // The option chosen already, as a person presses it: its radio.
    const preselected = document.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]'
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

  it("connects a toolkit that takes a key from its own form, a field Composio marks secret never shown as typed", async () => {
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {
        // The browser stays here for the test to read.
      });
    const [pipedesk] = integrationsOf(
      [{ ...entry("composio", "pipedesk", "Pipedesk"), auth: "key" }],
      []
    );
    const sent: unknown[] = [];
    await opened(
      someone("admin"),
      async () => await waitingForever(),
      pipedesk,
      {
        keyFields: async () =>
          await Promise.resolve([
            {
              name: "generic_api_key",
              label: "API key",
              description: "Your Pipedesk API key",
              required: true,
              secret: true,
            },
            {
              name: "subdomain",
              label: "Subdomain",
              description: null,
              required: true,
              secret: false,
            },
            {
              name: "region",
              label: "Region",
              description: null,
              required: false,
              secret: false,
            },
          ]),
        connectToolkitWithKey: async (request: unknown) => {
          sent.push(request);
          return await Promise.resolve({
            url: "/connectors/composio:pipedesk?connection=c1",
          });
        },
      }
    );
    await press(allow());
    await type(field("API key"), "pd_secret");
    const waitsForAll = button("Consent and connect")?.disabled;
    await type(field("Subdomain"), "acme");
    await press(button("Consent and connect"));

    expect({
      types: [field("API key")?.type, field("Subdomain")?.type],
      waitsForAll,
      sent,
      sentTo: assign.mock.calls,
    }).toStrictEqual({
      types: ["password", "text"],
      waitsForAll: true,
      sent: [
        {
          toolkit: "pipedesk",
          tools: [{ name: "HUBSPOT_LIST_CONTACTS", read: true }],
          consent: composioKeyConsentText,
          values: { generic_api_key: "pd_secret", subdomain: "acme" },
          returnTo: "/connectors/composio:pipedesk",
        },
      ],
      sentTo: [["/connectors/composio:pipedesk?connection=c1"]],
    });
  });

  it("offers no retry while a key is on its way, however long it takes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [pipedesk] = integrationsOf(
      [{ ...entry("composio", "pipedesk", "Pipedesk"), auth: "key" }],
      []
    );
    let sent = 0;
    await opened(
      someone("admin"),
      async () => await waitingForever(),
      pipedesk,
      {
        keyFields: async () =>
          await Promise.resolve([
            {
              name: "generic_api_key",
              label: "API key",
              description: null,
              required: true,
              secret: true,
            },
          ]),
        connectToolkitWithKey: async () => {
          sent += 1;
          return await waitingForever();
        },
      }
    );
    await press(allow());
    await type(field("API key"), "pd_secret");
    await press(button("Consent and connect"));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect({
      waiting: document.body.textContent?.includes("Waiting for Pipedesk"),
      retry: button("Try again"),
      sent,
    }).toStrictEqual({ waiting: true, retry: undefined, sent: 1 });
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

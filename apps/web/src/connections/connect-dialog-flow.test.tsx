// @vitest-environment happy-dom
import type { CatalogTool, ComposioToolRule } from "@grasp-os/shared/connect";
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
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ConnectDialog } from "./connect-dialog.tsx";
import { integrationsOf } from "./integrations.ts";
import type { Integration } from "./integrations.ts";
import { toolWords } from "./tool-choices.ts";

// The connect dialog against core's connections as the page reaches them
// over RPC, faked: what an admin chooses for each tool of a Composio
// toolkit is what connecting sends, and a native provider says where its
// sign-in page is.

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

const admin: Identity = {
  userId: "u1",
  email: "ada@example.com",
  name: "Ada",
  role: "admin",
  teams: [],
  staff: false,
  expiresAt: "2026-12-31T00:00:00.000Z",
};

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

const [hubspot] = integrationsOf([entry("composio", "hubspot", "HubSpot")], []);

const tools: CatalogTool[] = [
  {
    name: "HUBSPOT_LIST_CONTACTS",
    description: null,
    inputs: [],
    readOnly: true,
  },
  {
    name: "HUBSPOT_CREATE_NOTE",
    description: null,
    inputs: [],
    readOnly: false,
  },
];

let root: Root | undefined;

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The dialog open on `integration`, recording the tools connecting sends. */
const opened = async (
  integration: Integration | undefined
): Promise<(string | ComposioToolRule)[][]> => {
  if (integration === undefined) {
    throw new Error("No integration");
  }
  const sent: (string | ComposioToolRule)[][] = [];
  const connections = {
    catalogTools: async (): Promise<CatalogTool[]> =>
      await Promise.resolve(tools),
    connectToolkit: async (request: {
      tools: (string | ComposioToolRule)[];
    }): Promise<{ url: string }> => {
      sent.push(request.tools);
      // Refused, so the browser stays here for the test to read.
      return await Promise.reject(new Error("Not now"));
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ConnectDialog
        identity={admin}
        integration={integration}
        onOpenChange={() => {
          // The test reads what was sent, not the dialog closing.
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
  return sent;
};

const press = async (element: Element | null | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The row of the tool named `name`: the innermost list item that holds it. */
const row = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll("li")].find(
    (each) =>
      each.textContent?.includes(toolWords(name, "hubspot")) &&
      each.querySelector("li") === null
  );
  if (found === undefined) {
    throw new Error(`No row for ${name}`);
  }
  return found;
};

/** The answers, in the order the dialog lists them. */
const answers = ["View only", "View and change", "Everything", "Choose myself"];

/** The radio of the answer labelled `label`. */
const radio = (label: string): Element | undefined =>
  document.querySelectorAll('[data-slot="radio-group-item"]')[
    answers.indexOf(label)
  ];

/** The toggle `choice` (Off, Read or Write) in the row of the tool named `name`. */
const toggle = (name: string, choice: string): Element | undefined =>
  [...row(name).querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === choice
  );

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === text
  );

describe("choosing what Grasp may do in a toolkit", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("starts with every tool that only views on, as Read, and nothing that changes things", async () => {
    const sent = await opened(hubspot);
    expect(document.body.textContent).toContain("1 actions, all view only");
    await press(button("Allow and sign in"));
    expect(sent).toStrictEqual([
      [{ name: "HUBSPOT_LIST_CONTACTS", read: true }],
    ]);
  });

  it("turns on what changes things, as Write, in one choice", async () => {
    const sent = await opened(hubspot);
    await press(radio("View and change"));
    await press(button("Allow and sign in"));
    expect(sent).toStrictEqual([
      [{ name: "HUBSPOT_LIST_CONTACTS", read: true }, "HUBSPOT_CREATE_NOTE"],
    ]);
  });

  it("sends each tool as it was last set when choosing per action, and warns of Read against the hint", async () => {
    const sent = await opened(hubspot);
    await press(radio("Choose myself"));
    await press(toggle("HUBSPOT_LIST_CONTACTS", "Off"));
    await press(toggle("HUBSPOT_CREATE_NOTE", "Read"));
    expect(row("HUBSPOT_CREATE_NOTE").textContent).toContain(
      "As Read, it would do so without asking."
    );
    await press(button("Allow and sign in"));
    expect(sent).toStrictEqual([[{ name: "HUBSPOT_CREATE_NOTE", read: true }]]);
  });

  it("can't connect with every tool off", async () => {
    await opened(hubspot);
    await press(radio("Choose myself"));
    await press(toggle("HUBSPOT_LIST_CONTACTS", "Off"));
    expect(document.body.textContent).toContain("Nothing turned on yet");
    expect(button("Allow and sign in")?.disabled).toBeTruthy();
  });
});

// @vitest-environment happy-dom
import type { AppIntegration } from "@grasp-os/shared/apps";
import type { OfferedCatalog } from "@grasp-os/shared/connect";
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

import { AppIntegrations } from "./app-integrations.tsx";

// An App's integrations on its settings page, gated as core gates them: only
// its builders add one or take one off, and only one added by hand alone
// comes off; while the catalog can't be read, nothing is offered to add.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Entry = OfferedCatalog["entries"][number];

const entry = (id: string, name: string): Entry => ({
  source: "composio",
  id,
  name,
  categories: [],
  toolCount: 1,
  logo: null,
  description: null,
  group: "Other",
  auth: "managed",
  offered: true,
});

const catalog: Entry[] = [
  entry("hubspot", "HubSpot"),
  entry("notion", "Notion"),
  entry("slack", "Slack"),
  entry("jira", "Jira"),
];

const integrations: AppIntegration[] = [
  { source: "composio", id: "hubspot", why: ["permission"] },
  { source: "composio", id: "notion", why: ["added"] },
  { source: "composio", id: "slack", why: ["permission", "added"] },
];

let root: Root | undefined;

/** What the section asked core to change, and how often the page read again. */
interface Asked {
  changes: [string, string, unknown][];
  loads: number;
}

/** The section as the settings page renders it; what it asks of core. */
const shown = async (
  builds: boolean,
  entries: readonly Entry[] | null
): Promise<Asked> => {
  const asked: Asked = { changes: [], loads: 0 };
  const rootRoute = createRootRoute({
    // The page's read: counted, so a refresh after a change shows.
    loader: () => {
      asked.loads += 1;
    },
    component: () => (
      <AppIntegrations
        app={{ id: "app-1", name: "Desk" }}
        builds={builds}
        catalog={entries}
        integrations={integrations}
      />
    ),
  });
  // Core as the page reaches it: an App's integrations, each change kept.
  const session = {
    apps: {
      integrations: {
        add: async (app: string, ref: unknown) => {
          asked.changes.push(["add", app, ref]);
          await Promise.resolve();
        },
        remove: async (app: string, ref: unknown) => {
          asked.changes.push(["remove", app, ref]);
          await Promise.resolve();
        },
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (given: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
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
  return asked;
};

/** The button whose text or label is `name`. */
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name
  );

/** Every button's accessible name: its label, else its text. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map(
    (each) => each.getAttribute("aria-label") ?? each.textContent?.trim() ?? ""
  );

describe("an App's integrations in its settings", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("offer its builders adding one, and taking off only one added by hand alone", async () => {
    await shown(true, catalog);

    expect(buttons()).toStrictEqual([
      "Add an integration",
      "Take Notion off Desk",
    ]);
  });

  it("take one added by hand off when its builder asks, and read the page again", async () => {
    const asked = await shown(true, catalog);
    const before = asked.loads;
    await act(async () => {
      buttonNamed("Take Notion off Desk")?.click();
      await Promise.resolve();
    });

    expect({
      changes: asked.changes,
      readAgain: asked.loads > before,
    }).toStrictEqual({
      changes: [["remove", "app-1", { source: "composio", id: "notion" }]],
      readAgain: true,
    });
  });

  it("add the one its builder picks, and read the page again", async () => {
    const asked = await shown(true, catalog);
    const before = asked.loads;
    await act(async () => {
      buttonNamed("Add an integration")?.click();
      await Promise.resolve();
    });
    // Only what is offered and not there yet is listed: Jira alone.
    const offered = [...document.querySelectorAll("[role=option]")];
    await act(async () => {
      offered
        .find((each) => each.textContent?.includes("Jira"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect({
      // Each listed by its logo's initial and its name.
      offered: offered.map((each) => each.textContent?.trim()),
      changes: asked.changes,
      readAgain: asked.loads > before,
    }).toStrictEqual({
      offered: ["JJira"],
      changes: [["add", "app-1", { source: "composio", id: "jira" }]],
      readAgain: true,
    });
  });

  it("offer someone who doesn't build it neither", async () => {
    await shown(false, catalog);

    expect({
      buttons: buttons(),
      listed: document.body.textContent?.includes("HubSpot"),
    }).toStrictEqual({ buttons: [], listed: true });
  });

  it("offer nothing to add while the catalog can't be read, and say so", async () => {
    await shown(true, null);
    const add = [...document.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === "Add an integration"
    );

    expect({
      disabled: add?.disabled,
      said: document.body.textContent?.includes(
        "The catalog can’t be read right now"
      ),
      byId: document.body.textContent?.includes("hubspot"),
    }).toStrictEqual({ disabled: true, said: true, byId: true });
  });
});

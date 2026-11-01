// @vitest-environment happy-dom
import type { WorkflowResourceVersion } from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { VersionSource } from "./version-source.tsx";

// Any published version's definition and source, on the Versions tab,
// against core's workflowResources as the page reaches them over RPC,
// faked: the builder reads exactly the version they picked, its
// definition as published and each source file to download; anyone who
// doesn't build the workflow is offered nothing.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

/** A published version, as `versions` lists it, with only what the tab reads. */
const published = (version: number): WorkflowResourceVersion => ({
  resourceId: "workflow-1",
  version,
  definitionVersion: `1.${version}.0`,
  profile: "grasp-open-workflow/1",
  definitionHash: "definition",
  contractHash: "contract",
  manifestHash: "manifest",
  bindings: [],
  actions: [],
  modelSteeredWrites: [],
  build: { executable: true, hash: "build" },
  author: "ada",
  createdAt: "2026-10-30T09:00:00.000Z",
});

/** The section for a builder when `builder`: what core was asked. */
const shown = async (builder: boolean): Promise<unknown[]> => {
  const asked: unknown[] = [];
  const workflowResources = {
    definition: async (id: string, version: number) => {
      await Promise.resolve();
      asked.push({ definition: id, version });
      return `{"document":{"version":"1.${version}.0"}}`;
    },
    source: async (id: string, version: number) => {
      await Promise.resolve();
      asked.push({ source: id, version });
      return {
        files: {
          "workflow.json": "{}",
          "code/workflow.ts": "export default {};",
        },
      };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        workflowResources: typeof workflowResources;
      }) => Promise<T>
    ): Promise<T> => await action({ workflowResources }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <VersionSource
        builder={builder}
        versions={{ state: "ready", data: [published(2), published(1)] }}
        workflow="workflow-1"
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core },
  });
  await act(async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
    await settled();
  });
  return asked;
};

/** Presses the button whose text is `text`. */
const press = async (text: string): Promise<void> => {
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((each) => each.textContent.trim() === text)
      ?.click();
    await settled();
  });
};

describe("a version's definition and source", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows the definition of exactly the version picked, and lists its source files to download", async () => {
    const asked = await shown(true);
    const select = document.querySelector("select");
    const latest = select?.value;
    await act(async () => {
      if (select !== null) {
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await settled();
    });
    await press("Show its definition");
    await press("Its source files");

    expect({
      latest,
      asked,
      definition: document.querySelector("pre")?.textContent,
      downloads: [...document.querySelectorAll("button")]
        .map((each) => each.getAttribute("aria-label"))
        .filter((label) => label?.startsWith("Download") === true),
    }).toStrictEqual({
      // The latest, until another is picked.
      latest: "2",
      asked: [
        { definition: "workflow-1", version: 1 },
        { source: "workflow-1", version: 1 },
      ],
      definition: '{"document":{"version":"1.1.0"}}',
      downloads: ["Download workflow.json", "Download code/workflow.ts"],
    });
  });

  it("offers someone who doesn't build the workflow nothing", async () => {
    await shown(false);

    expect(document.body.textContent).toBe("");
  });
});

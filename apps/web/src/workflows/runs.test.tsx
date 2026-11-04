// @vitest-environment happy-dom
import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { ResourceListedRun } from "@grasp-os/shared/workflows";
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

import { RunsLog } from "./runs.tsx";

// The runs log as core lists an independent workflow's runs: one waiting
// for a decision the reader may answer leads to it, as an App's run does;
// one core names no decision for offers none.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** An independent workflow's run, as core lists it, with `fields`. */
const runOf = (
  id: string,
  fields: Partial<ResourceListedRun>
): ResourceListedRun => ({
  type: "resource",
  id: runIdSchema.parse(id),
  workflowId: workflowResourceIdSchema.parse("workflow-quotes"),
  name: "Quotes",
  version: 1,
  startedBy: { type: "person", userId: "user-ada" },
  status: "running",
  createdAt: "2026-11-04T09:00:00.000Z",
  endedAt: null,
  ...fields,
});

describe("the runs log", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("leads from an independent workflow's run to the decision it waits for, where the reader may answer it", async () => {
    const rootRoute = createRootRoute({
      component: () => (
        <RunsLog
          me="user-ada"
          model={undefined}
          more={false}
          runs={[
            runOf("run-waiting", { status: "waiting", decision: "decision-7" }),
            runOf("run-going", {}),
          ]}
        />
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory(),
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

    expect(
      [...document.querySelectorAll("a")]
        .filter((link) => link.textContent.trim() === "Decide")
        .map((link) => link.getAttribute("href"))
    ).toStrictEqual(["/decisions/decision-7"]);
  });
});

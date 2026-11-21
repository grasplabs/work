// @vitest-environment happy-dom
import { setTimeout as sleep } from "node:timers/promises";

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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { buildBrain } from "./brain.ts";
import { NoteBrainPage } from "./note-page.tsx";
import { testWorkspace } from "./test-workspace.ts";

// A Brain note's page as the person reads it: a link out of Grasp in its
// text opens only once the person says so, as a link in an answer does.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let opened: string[] = [];

const [note] = buildBrain(testWorkspace()).notes;
if (!note) {
  throw new Error("No note");
}

/** The note's page, its text `text`. */
const shown = async (text: string): Promise<void> => {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <NoteBrainPage byId={new Map()} facts={[]} note={note} text={text} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
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
  // The editor draws its text after its first paint.
  await act(async () => {
    await sleep(50);
  });
};

describe("a Brain note's page", () => {
  beforeEach(() => {
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    opened = [];
    document.body.replaceChildren();
  });

  it("asks before following a link out of Grasp, and opens it only once the person says so", async () => {
    await shown("See [the policy](https://policy.example/leave).");
    const link = [...document.querySelectorAll("a")].find(
      (each) => each.textContent === "the policy"
    );
    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
      );
      await Promise.resolve();
    });
    const before = [...opened];
    const asked = (
      document.querySelector("[role=alertdialog]")?.textContent ?? ""
    ).includes("https://policy.example/leave");
    const open = [...document.querySelectorAll("button")].find(
      (each) => each.textContent.trim() === "Open link"
    );
    await act(async () => {
      open?.click();
      await Promise.resolve();
    });

    expect({ found: link !== undefined, before, asked, opened }).toStrictEqual({
      found: true,
      before: [],
      asked: true,
      opened: ["https://policy.example/leave"],
    });
  });
});

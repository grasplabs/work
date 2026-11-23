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

  it("asks for a press with a key held and a middle press too, and sends no referrer", async () => {
    await shown("See [the policy](https://policy.example/leave).");
    const link = [...document.querySelectorAll("a")].find(
      (each) => each.textContent === "the policy"
    );
    const asks = [];
    for (const press of [
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }),
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        shiftKey: true,
      }),
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one press at a time
      await act(async () => {
        link?.dispatchEvent(press);
        await Promise.resolve();
      });
      asks.push({
        followed: !press.defaultPrevented,
        asked: document.querySelector("[role=alertdialog]") !== null,
      });
      const keep = [...document.querySelectorAll("button")].find(
        (each) => each.textContent.trim() === "Cancel"
      );
      // oxlint-disable-next-line no-await-in-loop -- one press at a time
      await act(async () => {
        keep?.click();
        await sleep(0);
      });
    }
    expect({
      rel: link?.getAttribute("rel"),
      referrer: link?.getAttribute("referrerpolicy"),
      asks,
      opened,
    }).toStrictEqual({
      rel: "noopener noreferrer",
      referrer: "no-referrer",
      asks: Array.from({ length: 4 }, () => ({ followed: false, asked: true })),
      opened: [],
    });
  });

  it("asks before following a picture's web address too", async () => {
    await shown("![The chart](https://charts.example/q3.png)");
    const link = [...document.querySelectorAll("a")].find(
      (each) => each.textContent === "The chart"
    );
    expect({
      href: link?.getAttribute("href"),
      referrer: link?.getAttribute("referrerpolicy"),
    }).toStrictEqual({
      href: "https://charts.example/q3.png",
      referrer: "no-referrer",
    });
  });

  it("links each place in the brain to its own route: a part, a page, the atlas and a note", async () => {
    await shown(
      [
        "[Vision](/brain/sections/vision)",
        "[Sources](/brain/sources)",
        "[the board](/brain?region=frontal)",
        "[Finance](/brain/team%2Ffinance#st-1)",
      ].join(" ")
    );
    const hrefs = Object.fromEntries(
      [...document.querySelectorAll("a")].map((each) => [
        each.textContent,
        each.getAttribute("href"),
      ])
    );
    expect(hrefs).toStrictEqual({
      Vision: "/brain/sections/vision",
      Sources: "/brain/sources",
      "the board": "/brain?region=frontal",
      Finance: "/brain/team%2Ffinance#st-1",
    });
  });
});

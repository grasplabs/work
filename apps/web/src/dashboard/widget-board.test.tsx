// @vitest-environment happy-dom
import { customWidgetIdSchema } from "@grasp-os/shared/widgets";
import type { CustomWidget } from "@grasp-os/shared/widgets";
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

import { noReturns } from "./returns.ts";
import { WidgetBoard } from "./widget-board.tsx";
import type { Board } from "./widget-board.tsx";

// Asking Grasp for a widget from the board's empty card, against core's
// dashboard as the page reaches it over RPC, faked: what was asked goes to
// core, the widget it made goes last on the board, drawn from the numbers
// core worked out, and a refusal is said where it was asked.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const widget: CustomWidget = {
  id: customWidgetIdSchema.parse("widget:00000000-0000-4000-8000-000000000001"),
  asked: "Which workflows failed?",
  madeAt: "2026-10-27T10:00:00.000Z",
  changedAt: "2026-10-27T10:00:00.000Z",
  spec: {
    title: "Failures this week",
    days: 7,
    parts: [{ type: "number", label: "Failed", measure: "failed" }],
  },
  view: {
    title: "Failures this week",
    days: 7,
    parts: [
      { type: "number", label: "Failed", measure: "failed", value: 3 },
      {
        type: "bars",
        label: null,
        measure: "workflows",
        by: "state",
        bars: [{ key: "failed", name: "failed", value: 2 }],
      },
    ],
  },
};

/** Lets the page's work after a core answer run. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** An empty board, whose core answers a request with `answer`. */
const shown = async (
  answer: () => Promise<{ widget: CustomWidget; note: string | null }>
) => {
  const asked: string[] = [];
  const dashboard = {
    makeWidget: async (request: string) => {
      asked.push(request);
      return await answer();
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { dashboard: typeof dashboard }) => Promise<T>
    ): Promise<T> => await action({ dashboard }),
  };
  // Never read: the board holds none of Grasp's own widgets.
  const { promise: never } = Promise.withResolvers<never>();
  const board: Board = {
    layout: [],
    offered: [],
    made: { state: "ready", data: [] },
    returns: noReturns,
    goals: never,
    workflows: never,
    engines: never,
    runs: never,
    signals: never,
    spend: undefined,
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <WidgetBoard board={board} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
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
  return { asked };
};

/** Opens the empty card and asks Grasp for `request`. */
const ask = async (request: string): Promise<void> => {
  const card = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add a widget"]'
  );
  await act(async () => {
    card?.click();
    await Promise.resolve();
  });
  await settled();
  const field = document.querySelector("textarea");
  if (field === null) {
    throw new TypeError("No field to ask in");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(field, request);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    field.form?.requestSubmit();
    await Promise.resolve();
  });
  await settled();
};

/** The titles of the board's blocks, in order. */
const titles = (): (string | null)[] =>
  [...document.querySelectorAll("section[aria-label]")].map((block) =>
    block.getAttribute("aria-label")
  );

describe(WidgetBoard, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("asks Grasp for a widget from the empty card and puts what it made last on the board, as core counted it", async () => {
    const { asked } = await shown(async () => {
      await Promise.resolve();
      return { widget, note: null };
    });

    await ask("  Which workflows failed?  ");
    const block = document.querySelector(
      'section[aria-label="Failures this week"]'
    );

    expect({
      asked,
      titles: titles(),
      number: block?.textContent.includes("3Failed") ?? false,
      // A state is named in words, not by core's key.
      state: block?.querySelector('ul[aria-label="Workflows"] li span')
        ?.textContent,
      card: document.querySelector("textarea") === null,
    }).toStrictEqual({
      asked: ["Which workflows failed?"],
      titles: ["Failures this week"],
      number: true,
      state: "Failed",
      card: true,
    });
  });

  it("says why when Grasp couldn't make it, and keeps what was asked to try again", async () => {
    const { asked } = await shown(async () => {
      await Promise.resolve();
      throw Object.assign(
        new Error(
          "Grasp could not make that into a widget. Try asking another way."
        ),
        { code: "dashboard.widget_unreadable" }
      );
    });

    await ask("A pie chart of the weather");

    expect({
      asked,
      titles: titles(),
      said: document.body.textContent.includes(
        "Grasp could not make that into a widget."
      ),
      kept: document.querySelector("textarea")?.value,
    }).toStrictEqual({
      asked: ["A pie chart of the weather"],
      titles: [],
      said: true,
      kept: "A pie chart of the weather",
    });
  });
});

import type { ModelEfforts } from "@grasp-os/shared/models";
// @vitest-environment happy-dom
import type { Identity } from "@grasp-os/shared/rpc";
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

import { Composer } from "./composer.tsx";
import { useAsk } from "./use-ask.ts";

// The chat box's one control for the model and how hard it thinks, in the
// box as a page shows it: a model is picked from the list with its
// provider's mark, an effort from the bar under it for a model that
// thinks, and both are kept for the person in this browser, so the box
// opens on them again. Only an admin is offered to add a provider.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const plain = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const thinker = "anthropic/claude-sonnet-5";
const models = [plain, thinker];
const efforts: Record<string, ModelEfforts> = {
  [thinker]: { levels: ["low", "high", "max"], default: "high" },
};

let root: Root | undefined;

/** The box to ask in, for someone with `role`, as a shell page shows it. */
const Box = () => {
  const { composer } = useAsk(undefined, models, efforts);
  return <Composer running={false} {...composer} />;
};

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

const opened = async (role: Identity["role"]): Promise<void> => {
  const identity: Identity = {
    userId: "user-1",
    email: "person@example.com",
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: "2026-10-23T00:00:00.000Z",
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity }),
    component: Outlet,
  });
  const routeTree = rootRoute.addChildren([
    shell.addChildren([
      createRoute({
        getParentRoute: () => shell,
        path: "/",
        component: Box,
      }),
    ]),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory(),
    context: { core: {} },
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

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The control that opens the picker, named for what it is set to. */
const control = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    'button[aria-label^="Model: "]'
  );
  if (found === null) {
    throw new Error("No model control");
  }
  return found;
};

/** The model's line in the open picker. */
const modelLine = (name: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      'fieldset[aria-label="Model"] button'
    ),
  ].find((button) => button.textContent?.includes(name));
  if (found === undefined) {
    throw new Error(`No model ${name}`);
  }
  return found;
};

/** The thinking bar's handle. */
const thinkingBar = (): HTMLInputElement => {
  const found = document.querySelector<HTMLInputElement>('input[type="range"]');
  const label = found?.getAttribute("aria-labelledby");
  if (
    found === null ||
    label === null ||
    label === undefined ||
    document.querySelector(`#${label}`)?.textContent !== "Thinking"
  ) {
    throw new Error("No thinking bar");
  }
  return found;
};

const key = async (element: HTMLElement, name: string): Promise<void> => {
  await act(async () => {
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true })
    );
    await Promise.resolve();
  });
  await settled();
};

describe("the model picker", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("picks a model, and how hard it thinks for one that does", async () => {
    await opened("user");
    // The default doesn't think: the control names it alone.
    expect(control().getAttribute("aria-label")).toBe(
      "Model: llama-3.3-70b-instruct-fp8-fast. Change model"
    );
    await press(control());
    // Pressed, and no bar for it.
    expect([
      modelLine("llama-3.3").getAttribute("aria-pressed"),
      document.querySelector('input[type="range"]'),
    ]).toStrictEqual(["true", null]);

    // One that thinks: the picker stays open on its bar, at its default.
    await press(modelLine("claude-sonnet-5"));
    expect(modelLine("claude-sonnet-5").getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(thinkingBar().getAttribute("aria-valuetext")).toBe("High");

    await key(thinkingBar(), "ArrowRight");
    expect(thinkingBar().getAttribute("aria-valuetext")).toBe("Max");
  });

  it("keeps the model and effort picked for the person, and opens on them again", async () => {
    await opened("user");
    await press(control());
    await press(modelLine("claude-sonnet-5"));
    await key(thinkingBar(), "ArrowRight");
    const chosen =
      "Model: claude-sonnet-5, thinking max. Change model or thinking";
    expect(control().getAttribute("aria-label")).toBe(chosen);

    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await opened("user");
    expect(control().getAttribute("aria-label")).toBe(chosen);
  });

  it("offers to add a provider to an admin alone", async () => {
    await opened("user");
    await press(control());
    expect(document.body.textContent).not.toContain("Add another provider");

    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await opened("admin");
    await press(control());
    const link = [...document.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Add another provider"
    );
    expect(link?.getAttribute("href")).toBe("/settings/models");
  });
});

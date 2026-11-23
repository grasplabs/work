// @vitest-environment happy-dom
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

import { ProfileName } from "./profile-name.tsx";

// Settings › Profile's name against core's `setName` as the page reaches
// it over RPC, faked: it refuses while `refusing`, and keeps the name
// otherwise. The name is saved as the field is left.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

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

/** Core's side of the name: what it was asked to keep, and what it keeps. */
const fakeCore = () => {
  const asked: string[] = [];
  const state = { refusing: true, kept: "Ada", asked };
  const session = {
    setName: async (name: string): Promise<void> => {
      await Promise.resolve();
      state.asked.push(name);
      if (state.refusing) {
        throw new Error("Grasp can't be reached right now.");
      }
      state.kept = name;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (given: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  return { core, state };
};

const shown = async (core: ReturnType<typeof fakeCore>["core"]) => {
  const rootRoute = createRootRoute({
    component: () => <ProfileName name="Ada" />,
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

const field = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("input");
  if (input === null) {
    throw new TypeError("No name field");
  }
  return input;
};

/** Types `name` into the field and leaves it, as a person changes their name. */
const typeAndLeave = async (name: string): Promise<void> => {
  const input = field();
  await act(async () => {
    input.focus();
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    input.blur();
    await Promise.resolve();
  });
  await settled();
};

describe("Settings › Profile › Name", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("keeps what was typed while core refuses it, and shows the name core took once it does", async () => {
    const { core, state } = fakeCore();
    await shown(core);

    await typeAndLeave("Ada Lovelace");
    const refused = field().value;
    state.refusing = false;
    await typeAndLeave("Ada Lovelace ");

    expect({
      refused,
      asked: state.asked,
      kept: state.kept,
      shown: field().value,
    }).toStrictEqual({
      refused: "Ada Lovelace",
      asked: ["Ada Lovelace", "Ada Lovelace"],
      kept: "Ada Lovelace",
      shown: "Ada Lovelace",
    });
  });
});

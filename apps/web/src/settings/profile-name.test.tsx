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

// Settings › Profile › Name, against core's `setName` as the page reaches
// it over RPC, faked: it takes a name, or refuses every one.

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

/** The name's row for Ann, core refusing every save when `refuses`: the names asked. */
const shown = async (refuses: boolean): Promise<string[]> => {
  const asked: string[] = [];
  const session = {
    setName: async (name: string): Promise<void> => {
      await Promise.resolve();
      asked.push(name);
      if (refuses) {
        throw new Error("Grasp couldn't save it.");
      }
    },
  };
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <ProfileName name="Ann" />,
    }),
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
  return asked;
};

const field = (): HTMLInputElement => {
  const found = document.querySelector("input");
  if (found === null) {
    throw new TypeError("No name field");
  }
  return found;
};

/** Types `name` into the field and leaves it, which saves it. */
const renamed = async (name: string): Promise<void> => {
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

  it("saves the name typed once the field is left", async () => {
    const asked = await shown(false);

    await renamed(" Ann de Vries ");

    expect({ asked, shown: field().value }).toStrictEqual({
      asked: ["Ann de Vries"],
      shown: "Ann de Vries",
    });
  });

  it("keeps the name typed in the field when core refuses it, as the row says", async () => {
    const asked = await shown(true);

    await renamed("Ann de Vries");

    expect({
      asked,
      shown: field().value,
      said: document.body.textContent.includes(
        "Could not save. Your name is kept."
      ),
    }).toStrictEqual({
      asked: ["Ann de Vries"],
      shown: "Ann de Vries",
      said: true,
    });
  });
});

// @vitest-environment happy-dom
import { appIdSchema } from "@grasp-os/shared/ids";
import type { OutputClass } from "@grasp-os/shared/screen-trust";
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

import { OutputClassControl } from "./output-class.tsx";

// Marking a domain's data sensitive or ordinary on its Approval section,
// against core's screen trust as the page reaches it over RPC (the
// boundary from the web app), faked: it keeps the class and the policy
// generation, moves the generation on with each change, and refuses a
// change under a generation that moved on, as core does.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const app = appIdSchema.parse("app-1");

/** Core's screen trust for one App, and each classification asked. */
const fakeTrust = (output: OutputClass, movedOnBy = 0) => {
  const asked: unknown[][] = [];
  let held = { output, generation: 4 };
  // What someone else did since the page read: the generation moved on.
  let shown = { ...held };
  held = { ...held, generation: held.generation + movedOnBy };
  const screenTrust = {
    read: async () => {
      await Promise.resolve();
      return { app, ...shown };
    },
    classify: async (
      id: string,
      next: OutputClass,
      generation: number
    ): Promise<OutputClass> => {
      await Promise.resolve();
      asked.push([id, next, generation]);
      if (generation !== held.generation) {
        throw new Error("This changed since you looked. Look again.");
      }
      held = { output: next, generation: generation + 1 };
      shown = held;
      return next;
    },
  };
  return { session: { screenTrust }, asked };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const shown = async (
  session: ReturnType<typeof fakeTrust>["session"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    loader: async () => await session.screenTrust.read(),
    component: () => <OutputClassControl review={rootRoute.useLoaderData()} />,
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

const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (button === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

const text = (): string => document.body.textContent ?? "";

describe("A domain's data, sensitive or ordinary", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("marks sensitive data ordinary under the generation reviewed, only once the admin confirms what it gives up", async () => {
    const { session, asked } = fakeTrust("sensitive");
    await shown(session);

    await press("Mark its data ordinary");
    expect(text()).toContain("code nobody read can send it elsewhere");
    await press("Cancel");
    const afterCancel = [...asked];
    await press("Mark its data ordinary");
    await press("Mark ordinary");

    expect({ afterCancel, asked }).toStrictEqual({
      afterCancel: [],
      asked: [["app-1", "ordinary", 4]],
    });
    expect(text()).toContain("Mark its data sensitive");
  });

  it("marks ordinary data sensitive again", async () => {
    const { session, asked } = fakeTrust("ordinary");
    await shown(session);

    await press("Mark its data sensitive");
    await press("Mark sensitive");

    expect(asked).toStrictEqual([["app-1", "sensitive", 4]]);
    expect(text()).toContain("Mark its data ordinary");
  });

  it("says why core refused when the approvals changed since the admin looked", async () => {
    const { session } = fakeTrust("sensitive", 1);
    await shown(session);

    await press("Mark its data ordinary");
    await press("Mark ordinary");

    expect(text()).toContain("This changed since you looked. Look again.");
  });
});

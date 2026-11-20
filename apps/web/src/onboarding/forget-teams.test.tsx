// @vitest-environment happy-dom
import type { OnboardingView } from "@grasp-os/shared/onboarding";
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

import { ForgetTeams } from "./forget-teams.tsx";

// The roster step's erase of the company's teams from the Brain, against
// core's onboarding as the page reaches it over RPC, faked: it keeps
// whether the Brain holds the teams, and the page reads that again after
// each change, as the setup page does.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Core's onboarding: the teams in the Brain until erased, back at the next confirmed save. */
const fakeOnboarding = () => {
  let teamsInBrain: OnboardingView["teamsInBrain"] = "in";
  return {
    api: {
      eraseTeamsFromBrain: async (): Promise<void> => {
        teamsInBrain = null;
        await Promise.resolve();
      },
    },
    /** The admin confirms the roster again, elsewhere on the page. */
    confirmed: () => {
      teamsInBrain = "in";
    },
    teamsInBrain: () => teamsInBrain,
  };
};

/** The step on what `onboarding` holds; its router, to read core again. */
const shown = async (onboarding: ReturnType<typeof fakeOnboarding>) => {
  const core = {
    withSession: async <T,>(
      action: (session: { onboarding: typeof onboarding.api }) => Promise<T>
    ): Promise<T> => await action({ onboarding: onboarding.api }),
  };
  /** Reads core again, as the setup page does once they are gone. */
  const readAgain = { now: async (): Promise<void> => {} };
  const rootRoute = createRootRoute({
    loader: () => onboarding.teamsInBrain(),
    component: () => (
      <ForgetTeams
        onErased={async () => {
          await readAgain.now();
        }}
        teamsInBrain={rootRoute.useLoaderData()}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  readAgain.now = async () => {
    await router.invalidate();
  };
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
  return router;
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

/** The button named `name`, by its text, if the page shows it. */
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );

const press = async (name: string): Promise<void> => {
  const found = button(name);
  if (found === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

/** What the step says, and whether it offers the erase. */
const step = () => ({
  said: document.querySelector("output")?.textContent ?? null,
  offered: button("Erase your teams from your Brain") !== undefined,
});

describe("erasing the company's teams from the Brain", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says they are erased, and offers the erase again once a confirmed save gives them back", async () => {
    const onboarding = fakeOnboarding();
    const router = await shown(onboarding);
    const before = step();

    await press("Erase your teams from your Brain");
    await press("Erase them");
    const erased = step();

    // Confirmed again on the same page: the Brain holds the teams again.
    onboarding.confirmed();
    await act(async () => {
      await router.invalidate();
    });
    await settled();

    expect({ before, erased, back: step() }).toStrictEqual({
      before: { said: null, offered: true },
      erased: {
        said: "Erased. Your Brain keeps nothing of your teams until you confirm them again.",
        offered: false,
      },
      back: { said: null, offered: true },
    });
  });
});

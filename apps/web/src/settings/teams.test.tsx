// @vitest-environment happy-dom
import type { DirectoryPlacement, Member } from "@grasp-os/shared/members";
import { staffListTeamRefusals } from "@grasp-os/shared/onboarding";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TeamsPanel } from "./teams.tsx";

// Settings › Members › Teams: renaming a team in its dialog and deleting
// one, as the admin hears why Better Auth refused it (core's auth.ts,
// GRA-2055): in the dialog they are in, while it stays open. Core answers
// the reads; Better Auth's routes answer every change as `refusing` says.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const ada: Member = {
  userId: "ada",
  name: "Ada",
  email: "ada@acme.test",
  role: "user",
  joinedAt: "2026-10-01T09:00:00.000Z",
  suspension: null,
};

const nobodyToPlace: DirectoryPlacement = {
  unplaced: [],
  movers: [],
  pins: [],
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

/** Better Auth refusing every change with `code`, and what it was asked. */
const refusing = (code: string): string[] => {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return await Promise.resolve(
      Response.json({ code, message: "Refused." }, { status: 409 })
    );
  });
  return asked;
};

/** The Teams tab, with one team, Sales, that Ada is in. */
const shown = async (): Promise<void> => {
  const session = {
    members: {
      teams: async () =>
        await Promise.resolve([
          { id: "team-sales", name: "Sales", memberIds: ["ada"] },
        ]),
      list: async () => await Promise.resolve([ada]),
      directoryPlacement: async () => await Promise.resolve(nobodyToPlace),
    },
  };
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: TeamsPanel }),
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

/** An element's words as a screen reader hears them: what is hidden from it left out. */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent?.trim() ?? "";
};

/** The last element matching `selector` with these words: a dialog's own over the page's. */
const found = (selector: string, words: string): HTMLElement => {
  const element = [
    ...document.querySelectorAll<HTMLElement>(selector),
  ].findLast(
    (each) =>
      wordsOf(each) === words || each.getAttribute("aria-label") === words
  );
  if (element === undefined) {
    throw new TypeError(`No ${selector} ${words}`);
  }
  return element;
};

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** What the open dialog of `role` says. */
const dialogText = (role: "dialog" | "alertdialog"): string =>
  document.querySelector(`[role="${role}"]`)?.textContent ?? "";

describe("Settings › Members › Teams", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("says in the open dialog why a rename was refused: a name the staff list gives a team not made yet", async () => {
    await shown();
    const asked = refusing(staffListTeamRefusals.notMadeYet);

    await click(found("button", "Sales"));
    const input = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input:not([type="search"])'
    );
    await act(async () => {
      if (input !== null) {
        Reflect.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set?.call(input, "Support");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await click(found("button", "Save changes"));

    expect({
      asked,
      said: dialogText("dialog").includes(
        "A team on the staff list has this name. It appears here once the staff list is confirmed."
      ),
    }).toStrictEqual({
      asked: ["/api/auth/organization/update-team"],
      said: true,
    });
  });

  it("says in the open delete dialog why core kept the team: it is on the staff list", async () => {
    await shown();
    const asked = refusing(staffListTeamRefusals.onList);

    await click(found("button", "Actions for Sales"));
    await click(found('[role="menuitem"]', "Delete"));
    await click(found('[role="alertdialog"] button', "Delete"));

    expect({
      asked,
      said: dialogText("alertdialog").includes(
        "This team is on the staff list. Take it off there and confirm the list first."
      ),
    }).toStrictEqual({
      asked: ["/api/auth/organization/remove-team"],
      said: true,
    });
  });
});

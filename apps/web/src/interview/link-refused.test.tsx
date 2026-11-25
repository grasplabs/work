// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { SessionEnded } from "../core-connection.ts";
import { Route } from "../routes/interview.tsx";

// The page of an interview link that opens nothing (`/interview#<secret>`),
// through its route, against core's interview route faked as `fetch`
// answers it: a link nobody made, or one made for another account than the
// one signed in, which core refuses alike (`interview.link_invalid`), so
// the page tells nothing about whose it is. It says the interview can't be
// opened, in core's words, and offers the way out to sign in as someone
// else: signing out. A link with no secret at all needs no way out.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/**
 * Waits until `ready` says so, React's updates flushed at each look. Fails
 * with `what` when it doesn't come.
 */
const until = async (ready: () => boolean, what: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await Promise.resolve();
      });
      if (!ready()) {
        throw new Error(`Still waiting for ${what}`);
      }
    },
    { timeout: 2000, interval: 5 }
  );
};

const text = (): string => document.body.textContent ?? "";

/**
 * The link's page opened with `secret`, someone signed in whom core
 * refuses it to: every address the page asked, and how the tab's
 * session was ended.
 */
const shown = async (secret: string) => {
  const posted: string[] = [];
  const ended: SessionEnded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: string) => Promise<Response>>(async (input) => {
      await Promise.resolve();
      posted.push(input);
      return input === "/api/auth/sign-out"
        ? Response.json({})
        : Response.json(
            {
              code: "interview.link_invalid",
              // Core's own words, whatever they are.
              message: "No interview opens on this link.",
            },
            { status: 404 }
          );
    })
  );
  window.history.replaceState(null, "", `/interview#${secret}`);
  const core = {
    end: (why: SessionEnded) => {
      ended.push(why);
    },
  };
  const top = createRootRoute({ component: Outlet });
  const pageAt = {
    id: "/interview",
    path: "/interview",
    getParentRoute: () => top,
  };
  // SAFETY: a place in the tree, as routeTree.gen.ts gives each route.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const page = Route.update(pageAt as Parameters<typeof Route.update>[0]);
  const router = createRouter({
    routeTree: top.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/interview"] }),
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
  await until(
    () => text().includes("This interview can't be opened"),
    "the refusal"
  );
  return { posted, ended };
};

const signOut = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === "Sign out"
  );

/** Takes the page away, and what it stubbed. */
const unmounted = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
};

describe("an interview link that opens nothing", () => {
  // The page's own file loads once, before the first test's clock starts.
  beforeAll(async () => {
    await shown("");
    unmounted();
  }, 60_000);

  afterEach(unmounted);

  it("says the interview can't be opened, in core's words, and signs out whoever is signed in for another account", async () => {
    const { posted, ended } = await shown("s".repeat(43));
    const refused = {
      said: text().includes("No interview opens on this link."),
      wayOut: signOut() !== undefined,
    };
    await act(async () => {
      signOut()?.click();
      await Promise.resolve();
    });
    await until(() => ended.length > 0, "the sign-out");

    expect({ refused, signedOut: posted.at(-1), ended }).toStrictEqual({
      refused: { said: true, wayOut: true },
      signedOut: "/api/auth/sign-out",
      ended: ["signed-out"],
    });
  });

  it("says a link with no secret doesn't work, and asks core nothing", async () => {
    const { posted } = await shown("");

    expect({
      said: text().includes(
        "This link doesn't work. Ask whoever sent it for a new one."
      ),
      wayOut: signOut() !== undefined,
      posted,
    }).toStrictEqual({ said: true, wayOut: false, posted: [] });
  });
});

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

import { InviteButton } from "./invitations.tsx";

// Invite, on Settings › Members, against core's `members.invite` as the
// page reaches it over RPC, faked: each invitation answers only when the
// test lets it, so what the dialog does while they are sent can be seen.

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

/** The Invite button, its invitations answered once `answer` is called. */
const shown = async (): Promise<{ answer: () => void; asked: string[] }> => {
  const asked: string[] = [];
  const answered = Promise.withResolvers<boolean>();
  const session = {
    members: {
      invite: async (email: string): Promise<void> => {
        asked.push(email);
        await answered.promise;
      },
    },
  };
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: InviteButton }),
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
  return {
    answer: () => {
      answered.resolve(true);
    },
    asked,
  };
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

/** The last button with these words: a dialog's own over the page's. */
const button = (words: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].findLast(
    (each) => wordsOf(each) === words
  );
  if (found === undefined) {
    throw new TypeError(`No button ${words}`);
  }
  return found;
};

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** Types `email` into the addresses field and ends it with a comma, which makes it a tag. */
const tagged = async (email: string): Promise<void> => {
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] [data-slot="tags-input"] input'
  );
  if (input === null) {
    throw new TypeError("No addresses field");
  }
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, email);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", bubbles: true })
    );
    await Promise.resolve();
  });
  await settled();
};

/** What the open dialog says. */
const dialogText = (): string =>
  document.querySelector('[role="dialog"]')?.textContent ?? "";

describe("Settings › Members › Invite", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("keeps the addresses when Cancel is pressed while the invitations are sent, as the dialog stays open", async () => {
    const { answer, asked } = await shown();
    await click(button("Invite"));
    await tagged("ann@acme.test");

    await click(button("Send invites"));
    await click(button("Cancel"));
    const whileSending = {
      open: document.querySelector('[role="dialog"]') !== null,
      kept: dialogText().includes("ann@acme.test"),
    };
    answer();
    await settled();

    expect({ asked, whileSending }).toStrictEqual({
      asked: ["ann@acme.test"],
      whileSending: { open: true, kept: true },
    });
  });
});

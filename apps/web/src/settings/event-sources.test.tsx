// @vitest-environment happy-dom
import type { EventSource } from "@grasp-os/shared/event-sources";
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

import type { Loaded } from "../load-from-core.tsx";
import { EventSourcesSettings } from "./event-sources.tsx";

// Settings › Webhooks, against core's workflowResources.sources as the
// page reaches them over RPC, faked: a source shows its URL with a way to
// copy it and how a sender signs; a new source's secret, and a rotated
// one, show once and never again once closed; rotating, revoking and
// deleting happen only once confirmed, and a refusal is said in the row.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

const secret = "whsec_c2hvd24tb25seS1vbmNl";

const shop: EventSource = {
  id: "source-shop",
  name: "Shop system",
  createdAt: "2026-10-01T09:00:00.000Z",
  createdBy: "admin",
  delivery: { token: "token-0b7c", secret: "active" },
};

/**
 * The page listing `listed`, its changes failing when `fails`, and every
 * read of the list after the first refused when `readsFail`, as its
 * route reads it again after each change: what core was asked.
 */
const shown = async (
  listed: readonly EventSource[] = [shop],
  fails = false,
  readsFail = false
): Promise<unknown[]> => {
  const asked: unknown[] = [];
  const answer = async <T,>(call: unknown, value: T): Promise<T> => {
    await Promise.resolve();
    asked.push(call);
    if (fails) {
      throw new Error("Core couldn't make the change.");
    }
    return value;
  };
  const sources = {
    create: async (input: unknown) =>
      await answer({ create: input }, { source: shop, secret }),
    rotateSecret: async (id: string) =>
      await answer(
        { rotateSecret: id },
        { source: shop, secret: `${secret}-rotated` }
      ),
    revokeSecret: async (id: string) =>
      await answer({ revokeSecret: id }, shop),
    delete: async (id: string) => {
      await answer({ delete: id }, null);
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        workflowResources: { sources: typeof sources };
      }) => Promise<T>
    ): Promise<T> => await action({ workflowResources: { sources } }),
  };
  let reads = 0;
  const read = async (): Promise<Loaded<readonly EventSource[]>> => {
    await Promise.resolve();
    reads += 1;
    return readsFail && reads > 1
      ? { state: "refused", message: "Core refused the read." }
      : { state: "ready", data: listed };
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    loader: read,
  });
  const Settings = () => <EventSourcesSettings page={page.useLoaderData()} />;
  page.update({ component: Settings });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core },
  });
  await act(async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
    await settled();
  });
  return asked;
};

/** An element's words as people get them: not the ones it hides from them. */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent.trim();
};

/** The buttons whose words are `text`. */
const buttons = (text: string): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter(
    (each) => wordsOf(each) === text
  );

/** The button named `name`, by its label. */
const named = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name
  );

/** The items of an open menu whose words are `text`. */
const menuItems = (text: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (each) => wordsOf(each) === text
  );

/** Opens source `name`'s menu, and chooses its item `text`. */
const choose = async (name: string, text: string): Promise<void> => {
  await act(async () => {
    named(`More for ${name}`)?.click();
    await settled();
  });
  await act(async () => {
    menuItems(text)[0]?.click();
    await settled();
  });
};

/** Opens the dialog for a new source. */
const openAdd = async (): Promise<void> => {
  await act(async () => {
    buttons("Add a source")[0]?.click();
    await settled();
  });
};

/** Presses the `index`th button whose text is `text`, and lets it settle. */
const press = async (text: string, index = 0): Promise<void> => {
  await act(async () => {
    buttons(text)[index]?.click();
    await settled();
  });
};

/** The value shown beside the copy button named `name`, if there is one. */
const copyValue = (name: string): string | undefined =>
  named(name)
    ?.closest('[data-slot="copy-field"]')
    ?.querySelector('[data-slot="copy-field-value"]')?.textContent ?? undefined;

/** Types `value` into the new source's name, as React hears a person do it. */
const typeName = async (value: string): Promise<void> => {
  await act(async () => {
    const found = document.querySelector<HTMLInputElement>("form input");
    if (found !== null) {
      Reflect.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(found, value);
      found.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settled();
  });
};

/** Submits the new source's form. */
const submit = async (): Promise<void> => {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settled();
  });
};

describe("the Webhooks settings", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows a source's URL with a way to copy it", async () => {
    await shown();
    const url = copyValue("Copy the URL of Shop system");
    await act(async () => {
      named("Copy the URL of Shop system")?.click();
      await settled();
    });

    expect({
      url,
      clipboard: await navigator.clipboard.readText(),
    }).toStrictEqual({
      url: `${globalThis.location.origin}/api/hooks/token-0b7c`,
      clipboard: `${globalThis.location.origin}/api/hooks/token-0b7c`,
    });
  });

  it("adds a source in a dialog by the name typed, trimmed, and shows its secret once, with how a sender signs, never again once closed", async () => {
    const asked = await shown([]);
    await openAdd();
    await typeName("  Stripe ");
    await submit();
    const shownOnce = copyValue("Copy the secret");
    const warned = document.body.textContent.includes("you won't see it again");
    const signing = document.body.textContent.includes("Standard Webhooks");
    await press("Done");

    expect({
      asked,
      shownOnce,
      warned,
      signing,
      afterClosing: copyValue("Copy the secret"),
    }).toStrictEqual({
      asked: [{ create: { name: "Stripe" } }],
      shownOnce: secret,
      warned: true,
      signing: true,
      afterClosing: undefined,
    });
  });

  it("keeps a new source's secret shown when reading the list again after it fails, and says why in the list's place", async () => {
    await shown([], false, true);
    await openAdd();
    await typeName("Stripe");
    await submit();

    expect({
      secret: copyValue("Copy the secret"),
      said: document.body.textContent.includes("Core refused the read."),
    }).toStrictEqual({ secret, said: true });
  });

  it("rotates a secret only once confirmed, and shows the new one once", async () => {
    const asked = await shown();
    await choose("Shop system", "Rotate the secret");
    const beforeConfirming = asked.length;
    await press("Rotate");

    expect({
      beforeConfirming,
      asked,
      shown: copyValue("Copy the secret"),
    }).toStrictEqual({
      beforeConfirming: 0,
      asked: [{ rotateSecret: shop.id }],
      shown: `${secret}-rotated`,
    });
  });

  it("revokes a secret and deletes a source only once confirmed", async () => {
    const asked = await shown();
    await choose("Shop system", "Revoke the secret");
    await press("Revoke");
    await choose("Shop system", "Delete");
    const beforeDeleting = asked.length;
    await press("Delete the source");

    expect({ beforeDeleting, asked }).toStrictEqual({
      beforeDeleting: 1,
      asked: [{ revokeSecret: shop.id }, { delete: shop.id }],
    });
  });

  it("says a revoked secret takes nothing, offering a new one and no revoke", async () => {
    await shown([
      { ...shop, delivery: { token: "token-0b7c", secret: "revoked" } },
    ]);
    await act(async () => {
      named("More for Shop system")?.click();
      await settled();
    });

    expect({
      revoked: document.body.textContent.includes("Secret revoked"),
      newOne: menuItems("Make a new secret").length,
      revoke: menuItems("Revoke the secret").length,
    }).toStrictEqual({ revoked: true, newOne: 1, revoke: 0 });
  });

  it("closes the confirmation and says why in the row when a change fails, showing no secret", async () => {
    await shown([shop], true);
    await choose("Shop system", "Rotate the secret");
    await press("Rotate");

    expect({
      confirming: buttons("Rotate").length,
      said: document.body.textContent.includes(
        "Core couldn't make the change."
      ),
      secret: copyValue("Copy the secret"),
    }).toStrictEqual({ confirming: 0, said: true, secret: undefined });
  });
});

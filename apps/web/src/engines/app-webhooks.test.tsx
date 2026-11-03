// @vitest-environment happy-dom
import type {
  AppWebhook,
  AppWebhookInput,
} from "@grasp-os/shared/app-webhooks";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useLoaderData,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppWebhooks, WebhookList } from "./app-webhooks.tsx";

// A domain's Webhooks tab (app-webhooks.tsx), against core's
// `apps.webhooks` as the page reaches it: Approve only for the
// workspace's admins, a new webhook's secret shown once, as core answers
// it, and the deliveries a webhook missed. Core decides all of it again
// (core's app-webhooks.test.ts); this is what the page offers.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Takes the page down. */
const takenDown = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

const app = appIdSchema.parse("invoice-desk");

/** A webhook of the App, approved or not. */
const webhookOf = (id: string, approved: boolean, dropped = 0): AppWebhook => ({
  id,
  app,
  url: `https://hooks.example.com/${id}`,
  events: ["form_sent"],
  approved: approved ? { by: "admin", at: "2026-10-27T10:00:00.000Z" } : null,
  createdBy: "builder",
  createdAt: "2026-10-27T09:00:00.000Z",
  dropped,
});

const secret = "gwhsec_shown-only-once";

/**
 * The tab, for `viewer`, whose core takes each webhook it is asked to add,
 * and lists `webhooks`: the first time, and each time after unless
 * `failsAfter`, when a list read again fails, as the page shows one.
 */
const shown = async (
  viewer: { role: Role; staff: boolean },
  webhooks: AppWebhook[],
  { failsAfter = false } = {}
) => {
  let reads = 0;
  const added: AppWebhookInput[] = [];
  const apps = {
    webhooks: {
      add: async (_app: string, input: AppWebhookInput) => {
        await Promise.resolve();
        added.push(input);
        return { webhook: webhookOf("new", false), secret };
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { apps: typeof apps }) => Promise<T>
    ): Promise<T> => await action({ apps }),
  };
  const Tab = () => {
    // The list as the page read it last: refused once `failsAfter`.
    const read: unknown = useLoaderData({ strict: false });
    return (
      <AppWebhooks app={app}>
        {read === "refused" ? (
          <p>Not loaded</p>
        ) : (
          <WebhookList identity={viewer} webhooks={webhooks} />
        )}
      </AppWebhooks>
    );
  };
  const router = createRouter({
    routeTree: createRootRoute({
      // Read again after each change, as the page reads its list.
      loader: () => {
        reads += 1;
        return reads > 1 && failsAfter ? "refused" : "listed";
      },
      component: Tab,
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
  return { added };
};

/** The names of the buttons on the page, dialogs included. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map(
    (each) => each.textContent?.trim() ?? ""
  );

/** Types `value` into `element`, as React hears a person type. */
const type = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(element) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** Presses the button named `name`, and lets core answer. */
const press = async (name: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The text of the row of webhook `id`, as the page shows it. */
const rowOf = (id: string): string =>
  [...document.querySelectorAll("li")].find((row) =>
    row.textContent?.includes(`hooks.example.com/${id}`)
  )?.textContent ?? "";

/** The secret the page shows, if it shows one. */
const secretShown = (): string | undefined =>
  [...document.querySelectorAll("input")].find(
    (input) => input.getAttribute("aria-label") === "Secret"
  )?.value;

describe(AppWebhooks, () => {
  afterEach(takenDown);

  it("offers Approve to an admin only, and adding and removing to every builder", async () => {
    const webhooks = [webhookOf("waiting", false), webhookOf("approved", true)];
    const seen: Record<string, string[]> = {};
    for (const [who, viewer] of [
      ["admin", { role: "admin", staff: false }],
      ["builder", { role: "builder", staff: false }],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await shown(viewer, webhooks);
      seen[who] = buttons();
      takenDown();
    }

    expect(seen).toStrictEqual({
      admin: ["Approve", "Remove", "Remove", "Add webhook"],
      builder: ["Remove", "Remove", "Add webhook"],
    });
  });

  it("says how many deliveries a webhook missed, and nothing for one that missed none", async () => {
    await shown({ role: "builder", staff: false }, [
      webhookOf("full", true, 3),
      webhookOf("fine", true),
    ]);
    expect({
      full: rowOf("full").includes(
        "3 events weren't sent: too many were waiting for this address."
      ),
      fine: rowOf("fine").includes("sent: too many were waiting"),
    }).toStrictEqual({ full: true, fine: false });
  });

  it("shows a new webhook's secret once, as core answers it, though the list read again after fails", async () => {
    const { added } = await shown({ role: "builder", staff: false }, [], {
      failsAfter: true,
    });
    const address = document.querySelector<HTMLInputElement>("#webhook-url");
    if (address === null) {
      throw new Error("Expected the address field");
    }

    await type(address, " https://hooks.example.com/forms ");
    await press("Add webhook");
    const shownOnce = secretShown();
    const listFailed = document.body.textContent?.includes("Not loaded");
    await press("Done");

    expect({
      added,
      shownOnce,
      listFailed,
      after: secretShown(),
    }).toStrictEqual({
      added: [
        { url: "https://hooks.example.com/forms", events: ["form_sent"] },
      ],
      shownOnce: secret,
      listFailed: true,
      after: undefined,
    });
  });
});

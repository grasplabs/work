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
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppWebhooks } from "./app-webhooks.tsx";

// A domain's Webhooks tab (app-webhooks.tsx), against core's
// `apps.webhooks` as the page reaches it: Approve only for the
// workspace's admins, adding never for Grasp staff, and a new webhook's
// secret shown once, as core answers it. Core decides all of it again
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
const webhookOf = (id: string, approved: boolean): AppWebhook => ({
  id,
  app,
  url: `https://hooks.example.com/${id}`,
  events: ["form_sent"],
  approved: approved ? { by: "admin", at: "2026-10-27T10:00:00.000Z" } : null,
  createdBy: "builder",
  createdAt: "2026-10-27T09:00:00.000Z",
});

const secret = "gwhsec_shown-only-once";

/** The tab, for `viewer`, whose core takes each webhook it is asked to add. */
const shown = async (
  viewer: { role: Role; staff: boolean },
  webhooks: AppWebhook[]
) => {
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
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AppWebhooks app={app} identity={viewer} webhooks={webhooks} />
      ),
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

/** The secret the page shows, if it shows one. */
const secretShown = (): string | undefined =>
  [...document.querySelectorAll("input")].find(
    (input) => input.getAttribute("aria-label") === "Secret"
  )?.value;

describe(AppWebhooks, () => {
  afterEach(takenDown);

  it("offers Approve to an admin only, and adding to anyone but Grasp staff", async () => {
    const webhooks = [webhookOf("waiting", false), webhookOf("approved", true)];
    const seen: Record<string, string[]> = {};
    for (const [who, viewer] of [
      ["admin", { role: "admin", staff: false }],
      ["builder", { role: "builder", staff: false }],
      ["staff", { role: "admin", staff: true }],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await shown(viewer, webhooks);
      seen[who] = buttons();
      takenDown();
    }

    expect(seen).toStrictEqual({
      admin: ["Approve", "Remove", "Remove", "Add webhook"],
      builder: ["Remove", "Remove", "Add webhook"],
      staff: ["Remove", "Remove"],
    });
  });

  it("shows a new webhook's secret once, as core answers it", async () => {
    const { added } = await shown({ role: "builder", staff: false }, []);
    const address = document.querySelector<HTMLInputElement>("#webhook-url");
    if (address === null) {
      throw new Error("Expected the address field");
    }

    await type(address, " https://hooks.example.com/forms ");
    await press("Add webhook");
    const shownOnce = secretShown();
    await press("Done");

    expect({ added, shownOnce, after: secretShown() }).toStrictEqual({
      added: [
        { url: "https://hooks.example.com/forms", events: ["form_sent"] },
      ],
      shownOnce: secret,
      after: undefined,
    });
  });
});

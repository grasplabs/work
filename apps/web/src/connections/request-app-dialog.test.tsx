// @vitest-environment happy-dom
import type { AppRequest, AppRequestInput } from "@grasp-os/shared/connect";
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

import { integrationsOf } from "./integrations.ts";
import { RequestAppDialog } from "./request-app-dialog.tsx";

// The Request app dialog against core's connections as the page reaches
// them over RPC (the boundary from the web app), faked: the apps already
// here come first, a name asked for before is refused, and a request ends
// on "Forwarded to our team" having sent exactly what the person gave.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const entry = (id: string, name: string) => ({
  source: "composio" as const,
  id,
  name,
  categories: ["HR"],
  toolCount: 3,
  logo: null,
  description: null,
  group: "Other" as const,
  auth: "managed" as const,
  offered: true,
});

const integrations = integrationsOf(
  [entry("hubspot", "HubSpot"), entry("personio_hr", "Personio HR")],
  []
);

const earlier: AppRequest = {
  id: "request-1",
  name: "Twinfield",
  why: null,
  url: null,
  requestedBy: { userId: "u1", name: "Sanne" },
  requestedAt: "2026-10-01T08:00:00.000Z",
};

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

/** The dialog open against core's connections, recording what it asked for. */
const opened = async (): Promise<AppRequestInput[]> => {
  const sent: AppRequestInput[] = [];
  const connections = {
    appRequests: async (): Promise<AppRequest[]> =>
      await Promise.resolve([earlier]),
    requestApp: async (request: AppRequestInput): Promise<AppRequest> => {
      sent.push(request);
      return await Promise.resolve({ ...earlier, name: request.name });
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <RequestAppDialog
        integrations={integrations}
        onOpenChange={() => {
          // The test reads what was sent, not the dialog closing.
        }}
        open
      />
    ),
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
  return sent;
};

const field = (id: string): HTMLInputElement | HTMLTextAreaElement => {
  const found = document.querySelector(`#${id}`);
  if (
    !(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)
  ) {
    throw new TypeError(`No field ${id}`);
  }
  return found;
};

/** Types `value` into `element`, as React hears a person type. */
const type = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
): Promise<void> => {
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

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );

const click = async (name: string): Promise<void> => {
  const found = button(name);
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

describe("requesting an app", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows the apps already here and asks for the link and reason only once none of them is meant", async () => {
    await opened();
    await type(field("request-name"), "hubs");
    expect(document.body.textContent).toContain("HubSpot");
    expect(document.querySelector("#request-why")).toBeNull();

    await click("It is not one of these");
    expect(document.querySelector("#request-url")).not.toBeNull();
    expect(document.querySelector("#request-why")).not.toBeNull();
  });

  it("refuses a name that was asked for before, saying who asked", async () => {
    const sent = await opened();
    await type(field("request-name"), "twinfield");
    expect(document.body.textContent).toContain("Sanne already asked for it");
    expect(button("Send request")?.disabled).toBeTruthy();
    expect(sent).toStrictEqual([]);
  });

  it("sends the name, link and reason, then says it was forwarded", async () => {
    const sent = await opened();
    await type(field("request-name"), "Exact Online");
    await type(field("request-url"), "https://exact.example");
    await type(field("request-why"), "Read invoices");
    await click("Send request");
    expect(sent).toStrictEqual([
      {
        name: "Exact Online",
        url: "https://exact.example",
        why: "Read invoices",
      },
    ]);
    expect(document.body.textContent).toContain("Forwarded to our team");
  });

  it("does not send a link that is not a web address", async () => {
    const sent = await opened();
    await type(field("request-name"), "Exact Online");
    await type(field("request-url"), "exact");
    expect(button("Send request")?.disabled).toBeTruthy();
    expect(sent).toStrictEqual([]);
  });
});

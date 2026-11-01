// @vitest-environment happy-dom
import type { SignInSettings } from "@grasp-os/shared/org-settings";
import type { Role } from "@grasp-os/shared/roles";
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

import { SignInSection } from "./sign-in-settings.tsx";

// Settings › Workspace › Sign-in against core's organization settings as
// the page reaches them over RPC (the boundary from the web app), faked:
// what Grasp set up for the deployment, read only, and how often it was
// read, under the shell that knows who is signed in.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const both: SignInSettings = {
  configured: true,
  domains: ["acme.test"],
  providers: [
    {
      provider: "microsoft",
      tenantId: "7f9a2c1e-0000-4000-8000-000000000001",
      clientId: "client-ms",
      secretSet: true,
      offered: true,
    },
    {
      provider: "google",
      hostedDomain: "acme.test",
      clientId: "client-google",
      secretSet: false,
      offered: false,
    },
  ],
  staffWindow: null,
};

/** Core's organization settings, answering `signIn` with `settings`. */
const fakeOrgSettings = (settings: SignInSettings | Error) => {
  const read = { count: 0 };
  const orgSettings = {
    signIn: async (): Promise<SignInSettings> => {
      await Promise.resolve();
      read.count += 1;
      if (settings instanceof Error) {
        throw settings;
      }
      return settings;
    },
  };
  return { session: { orgSettings }, read };
};

let root: Root | undefined;

/** The section under the shell, for someone of `role`. */
const shown = async (
  session: ReturnType<typeof fakeOrgSettings>["session"],
  role: Role = "admin"
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity: { role, staff: false } }),
    component: Outlet,
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/",
    component: SignInSection,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page])]),
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
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const text = (): string => document.body.textContent ?? "";

describe("Settings › Workspace › Sign-in", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows an admin each way people sign in, whose accounts it takes, and whether the sign-in page offers it", async () => {
    const { session } = fakeOrgSettings(both);
    await shown(session);

    expect({
      microsoft: text().includes(
        "Only accounts of the tenant 7f9a2c1e-0000-4000-8000-000000000001."
      ),
      google: text().includes(
        "Only accounts of the Google Workspace acme.test."
      ),
      offered: text().includes("On the sign-in page"),
      missing: text().includes("Not offered: its secret isn’t set"),
      noSecret:
        text().includes("client-ms") || text().includes("client-google"),
    }).toStrictEqual({
      microsoft: true,
      google: true,
      offered: true,
      missing: true,
      noSecret: false,
    });
  });

  it("says when sign-in isn't set up yet", async () => {
    const { session } = fakeOrgSettings({
      configured: false,
      domains: [],
      providers: [],
      staffWindow: null,
    });
    await shown(session);

    expect(text()).toContain(
      "Sign-in isn’t set up for this workspace yet, so nobody can sign in."
    );
  });

  it("says why core refused to say", async () => {
    const { session } = fakeOrgSettings(
      new Error("Only an admin of the organization can do this.")
    );
    await shown(session);

    expect(text()).toContain("Only an admin of the organization can do this.");
  });

  it("shows nothing to someone who isn't an admin, and doesn't ask core", async () => {
    const { session, read } = fakeOrgSettings(both);
    await shown(session, "user");

    expect({ shown: text(), read: read.count }).toStrictEqual({
      shown: "",
      read: 0,
    });
  });
});

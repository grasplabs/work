// @vitest-environment happy-dom
import type {
  App,
  AppMember,
  AppStatus,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { ListedConnection } from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppSettings } from "./app-settings.tsx";
import type { AppSettingsSection } from "./app-settings.tsx";

// An App's settings against core's `apps` and `pages` as the page
// reaches them over RPC (the boundary from the web app), faked: the
// sections each viewer sees, linked where they stand (the workspace or the
// settings page), and General, which only its builders change, archiving
// the App only once they confirm.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** An HTTP connection an admin approved. */
const billing: ListedConnection = {
  id: "connection-billing",
  source: "http",
  provider: "http",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "admin",
  connectedByName: "Admin",
  accountName: null,
  createdAt: "2026-11-01T09:00:00.000Z",
  http: {
    name: "Billing API",
    origin: "https://billing.example.com",
    pathPrefixes: ["/v1/invoices"],
    methods: ["GET"],
    credentialHeader: "x-api-key",
  },
};

/** Core's `apps` and `pages` for one App, as someone with `role` in it reads it. */
const fakeCore = (
  role: ViewedApp["role"],
  status: AppStatus = "published",
  { surfacesRefused = false }: { surfacesRefused?: boolean } = {}
) => {
  const calls: string[] = [];
  /** Whether core is out of reach from now on. */
  const state = { unreachable: false };
  let members: AppMember[] = [
    {
      type: "person",
      id: "user-ann",
      name: "Ann",
      role: "user",
      addedBy: "user-1",
      addedAt: "2026-10-30T09:00:00.000Z",
    },
  ];
  let app: ViewedApp = {
    id: appIdSchema.parse("invoice-desk"),
    name: "Invoices",
    description: "Open invoices, by due date",
    owner: "user-1",
    responsible: "user-1",
    audience: null,
    process: null,
    blueprint: null,
    currentVersion: 1,
    pendingVersion: null,
    status,
    link: null,
    createdAt: "2026-10-20T08:00:00.000Z",
    role,
  };
  return {
    calls,
    state,
    apps: {
      get: async (): Promise<ViewedApp> => await Promise.resolve(app),
      archive: async (): Promise<App> => {
        calls.push("archive");
        await Promise.resolve();
        app = { ...app, status: "archived" };
        return app;
      },
      answerers: async () =>
        await Promise.resolve([{ id: "user-1", name: "Ada" }]),
      members: {
        list: async () => {
          await Promise.resolve();
          if (state.unreachable) {
            throw new Error("Grasp can't be reached right now.");
          }
          return members;
        },
        remove: async (_app: string, ref: { id: string }) => {
          calls.push(`unshare ${ref.id}`);
          await Promise.resolve();
          members = members.filter(({ id }) => id !== ref.id);
        },
      },
    },
    pages: {
      surfaces: async () => {
        await Promise.resolve();
        if (surfacesRefused) {
          throw new Error("The App's surfaces can't be read now.");
        }
        return [];
      },
    },
    // Core lists the App's packages only to who may approve them.
    dependencies: {
      approvals: async () => {
        await Promise.resolve();
        throw new Error("Only package approvers read these.");
      },
    },
    // The App may use one HTTP connection, which no catalog entry lists.
    permissions: {
      list: async () =>
        await Promise.resolve([
          {
            object: { type: "connection", connectionId: billing.id },
            status: "granted",
          },
        ]),
    },
    connections: {
      list: async (): Promise<ListedConnection[]> =>
        await Promise.resolve([billing]),
      catalog: async () => await Promise.resolve({ entries: [] }),
    },
  };
};

const identityOf = (role: Identity["role"] = "user"): Identity => ({
  userId: "user-2",
  email: "user-2@acme.test",
  name: "user-2",
  role,
  teams: [],
  staff: false,
  expiresAt: "2026-11-01T09:00:00.000Z",
});

let root: Root | undefined;

/** Lets every pending promise and render settle, the page's reload too. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 10);
    await promise;
  });
};

const isApp = (data: unknown): data is ViewedApp =>
  typeof data === "object" && data !== null && "status" in data;

/** The App's settings, from `fake`, `within` the workspace or the page. */
const opened = async (
  fake: ReturnType<typeof fakeCore>,
  within: "workspace" | "page" = "page",
  section?: AppSettingsSection,
  role: Identity["role"] = "user"
) => {
  const { apps, pages, dependencies, permissions, connections } = fake;
  const core = {
    withSession: async <T,>(
      action: (session: {
        apps: typeof apps;
        pages: typeof pages;
        dependencies: typeof dependencies;
        permissions: typeof permissions;
        connections: typeof connections;
      }) => Promise<T>
    ): Promise<T> =>
      await action({ apps, pages, dependencies, permissions, connections }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await apps.get(),
  });
  const Page = () => {
    const loaded: unknown = useRouterState<AnyRouter>({
      select: ({ matches }) => matches.at(0)?.loaderData,
    });
    if (!isApp(loaded)) {
      return null;
    }
    return (
      <AppSettings
        app={loaded}
        identity={identityOf(role)}
        section={section}
        storeChanges={undefined}
        within={within}
      />
    );
  };
  rootRoute.update({ component: Page });
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
  return router;
};

/** The App's name field, in General. */
const nameField = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>("#app-name");

const nameOf = (element: HTMLElement): string => element.textContent.trim();

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => nameOf(each) === name || each.getAttribute("aria-label") === name
  );

const press = async (name: string): Promise<void> => {
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

/** The sections listed, each with where it links. */
const sections = () =>
  [...document.querySelectorAll('nav[aria-label="Settings sections"] a')].map(
    (link) => ({
      name: link.textContent,
      to: link.getAttribute("href"),
      open: link.getAttribute("aria-current") === "page",
    })
  );

/** Whether a section says its latest re-read failed. */
const note = (): boolean =>
  document.body.textContent.includes("Couldn't refresh");

describe(AppSettings, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lists to its builders the sections only they read, linked within the workspace", async () => {
    await opened(fakeCore("builder"), "workspace");
    const builder = sections();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await opened(fakeCore("user"));

    expect({ builder, user: sections() }).toStrictEqual({
      builder: [
        {
          name: "General",
          to: "/apps/invoice-desk/edit?view=settings&section=general",
          open: true,
        },
        {
          name: "Sharing",
          to: "/apps/invoice-desk/edit?view=settings&section=sharing",
          open: false,
        },
        {
          name: "Versions",
          to: "/apps/invoice-desk/edit?view=settings&section=versions",
          open: false,
        },
        {
          name: "Webhooks",
          to: "/apps/invoice-desk/edit?view=settings&section=webhooks",
          open: false,
        },
        {
          name: "Packages",
          to: "/apps/invoice-desk/edit?view=settings&section=packages",
          open: false,
        },
      ],
      user: [
        {
          name: "General",
          to: "/apps/invoice-desk/settings?section=general",
          open: true,
        },
        {
          name: "Sharing",
          to: "/apps/invoice-desk/settings?section=sharing",
          open: false,
        },
      ],
    });
  });

  it("shows someone who uses the App its settings to read, and nothing to change", async () => {
    await opened(fakeCore("user"));

    const name = document.querySelector<HTMLInputElement>("#app-name");
    expect({
      name: name?.value,
      readOnly: name?.readOnly,
      archive: button("Archive and take offline"),
      said: document.body.textContent.includes(
        "Only its builders change these settings."
      ),
    }).toStrictEqual({
      name: "Invoices",
      readOnly: true,
      archive: undefined,
      said: true,
    });
  });

  it("archives the App for a builder only once they confirm", async () => {
    const fake = fakeCore("builder");
    await opened(fake);

    await press("Archive and take offline");
    await press("Cancel");
    const afterCancel = [...fake.calls];
    await press("Archive and take offline");
    await press("Archive");

    expect({
      afterCancel,
      calls: fake.calls,
      restore: button("Restore") !== undefined,
    }).toStrictEqual({ afterCancel: [], calls: ["archive"], restore: true });
  });

  it("shows a change made in a section, read again with the page", async () => {
    const fake = fakeCore("builder");
    await opened(fake, "page", "sharing");
    const before = document.body.textContent.includes("Ann");

    await press("Stop sharing with Ann");
    await press("Stop sharing");

    expect({
      before,
      calls: fake.calls,
      after: document.body.textContent.includes("Ann"),
      said: document.body.textContent.includes("It isn’t shared with anyone."),
    }).toStrictEqual({
      before: true,
      calls: ["unshare user-ann"],
      after: false,
      said: true,
    });
  });

  it("lists an HTTP connection the App uses among its connections in use", async () => {
    await opened(fakeCore("builder"), "workspace", "connections", "builder");

    const used = document.querySelector('[aria-labelledby="app-used"]');
    expect({
      listed: used?.querySelector("h4")?.textContent,
      origin: used?.textContent.includes("https://billing.example.com"),
      none: used?.textContent.includes("doesn't use a connection yet"),
      revoke: used?.querySelector("button"),
    }).toStrictEqual({
      listed: "Billing API",
      origin: true,
      none: false,
      revoke: null,
    });
  });

  it("keeps every section usable when one of its reads is refused", async () => {
    await opened(fakeCore("builder", "published", { surfacesRefused: true }));

    expect({
      name: document.querySelector<HTMLInputElement>("#app-name")?.value,
      sections: sections().map(({ name }) => name),
    }).toStrictEqual({
      name: "Invoices",
      sections: ["General", "Sharing", "Versions", "Webhooks", "Packages"],
    });
  });

  it("keeps what General showed, and what is typed in it, when a re-read can't reach core", async () => {
    const fake = fakeCore("builder");
    const router = await opened(fake);
    const field = nameField();
    if (field === null) {
      throw new Error("No name field");
    }
    await act(async () => {
      const prototype = Reflect.getPrototypeOf(field) ?? {};
      Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
        field,
        "Invoice desk"
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    fake.state.unreachable = true;
    await act(async () => {
      await router.invalidate();
    });
    await settled();

    expect(nameField()?.value).toBe("Invoice desk");
  });

  it("says a re-read failed over what it still shows, and reads again on Try again", async () => {
    const fake = fakeCore("builder");
    const router = await opened(fake);
    const before = note();

    fake.state.unreachable = true;
    await act(async () => {
      await router.invalidate();
    });
    await settled();
    const failed = {
      note: note(),
      why: document.body.textContent.includes(
        "Grasp can't be reached right now."
      ),
      name: nameField()?.value,
    };
    fake.state.unreachable = false;
    await press("Try again");
    await settled();

    expect({ before, failed, after: note() }).toStrictEqual({
      before: false,
      failed: { note: true, why: true, name: "Invoices" },
      after: false,
    });
  });
});

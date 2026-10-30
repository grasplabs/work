// @vitest-environment happy-dom
import type {
  AcceptedUpdate,
  AppVersion,
  BlueprintUpdate,
  ViewedApp,
} from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
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

import { BlueprintUpdateBanner } from "./blueprint-update.tsx";

// A built-in blueprint's update on the domain page of an App created from
// it, against core's `apps.blueprints` as the page reaches it over RPC (the
// boundary from the web app), faked: it offers the update merged over the
// App's latest version, commits it as the next version when accepted over
// exactly what it offered, and refuses it otherwise, as core does.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const intake: ViewedApp = {
  id: appId,
  name: "Intake",
  description: "",
  owner: "user-owner",
  responsible: "user-owner",
  audience: null,
  blueprint: null,
  currentVersion: 4,
  pendingVersion: null,
  status: "published",
  process: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  role: "builder",
};

const offered: BlueprintUpdate = {
  blueprint: "intake",
  from: "a".repeat(64),
  to: "b".repeat(64),
  over: 4,
  changes: [
    {
      path: "screens/form.tsx",
      change: "modified",
      before: "export const Form = () => null;",
      after: "export const Form = () => <form />;",
    },
    { path: "lib/validate.ts", change: "added", after: "export {};" },
  ],
  conflicts: ["screens/list.tsx"],
};

/** Core's blueprints for the App: the update it offers, and each call. */
const fakeBlueprints = ({ movedOn = false } = {}) => {
  const asked: unknown[][] = [];
  let update: BlueprintUpdate | null = offered;
  const blueprints = {
    update: async (app: string): Promise<BlueprintUpdate | null> => {
      await Promise.resolve();
      asked.push(["update", app]);
      return update;
    },
    acceptUpdate: async (
      app: string,
      accepted: AcceptedUpdate
    ): Promise<Pick<AppVersion, "version">> => {
      await Promise.resolve();
      asked.push(["acceptUpdate", app, accepted]);
      if (movedOn || update === null || accepted.to !== update.to) {
        throw new Error("This changed since you looked. Look again.");
      }
      update = null;
      return { version: 5 };
    },
  };
  return { session: { apps: { blueprints } }, asked };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const shown = async (
  session: ReturnType<typeof fakeBlueprints>["session"],
  { app = intake, staff = false } = {}
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <BlueprintUpdateBanner app={app} identity={{ staff }} />,
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
};

const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
};

const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (button === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

const text = (): string => document.body.textContent ?? "";

/** What `viewer` is shown of the update, and what the page asked of core. */
const seenBy = async (options: { app?: ViewedApp; staff?: boolean }) => {
  const { session, asked } = fakeBlueprints();
  await shown(session, options);
  const banner = text().includes("has an update");
  unmount();
  return { asked, banner };
};

describe("A built-in blueprint's update, for the builders of an App made from it", () => {
  afterEach(() => {
    unmount();
  });

  it("shows what changes and what stays theirs, and takes it only once accepted", async () => {
    const { session, asked } = fakeBlueprints();
    await shown(session);

    expect(text()).toContain("It changes 2 files.");
    await press("Review the update");
    expect(text()).toContain("screens/form.tsx");
    expect(text()).toContain("1 file stays as your builders made it");
    await press("Cancel");
    const afterCancel = [...asked];
    await press("Review the update");
    await press("Take the update");

    expect({ afterCancel, asked }).toStrictEqual({
      afterCancel: [["update", "app-1"]],
      asked: [
        ["update", "app-1"],
        ["acceptUpdate", "app-1", { to: "b".repeat(64), over: 4 }],
      ],
    });
    expect(text()).toContain("The blueprint's update is version 5");
  });

  it("says why core refused when the update moved on since it was read", async () => {
    const { session } = fakeBlueprints({ movedOn: true });
    await shown(session);

    await press("Review the update");
    await press("Take the update");

    expect(text()).toContain("This changed since you looked. Look again.");
  });

  it("is offered to none but its builders, never Grasp staff, nor on an archived domain", async () => {
    const seen = {
      builder: await seenBy({}),
      user: await seenBy({ app: { ...intake, role: "user" } }),
      staff: await seenBy({ staff: true }),
      archived: await seenBy({ app: { ...intake, status: "archived" } }),
    };

    expect(seen).toStrictEqual({
      builder: { asked: [["update", "app-1"]], banner: true },
      user: { asked: [], banner: false },
      staff: { asked: [], banner: false },
      archived: { asked: [], banner: false },
    });
  });
});

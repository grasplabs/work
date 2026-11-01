// @vitest-environment happy-dom
import type { AppRelease, AppVersion, ViewedApp } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
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

import { AppVersions } from "./app-versions.tsx";

// Revoking a domain's release and placing or lifting a legal hold on it,
// on its Versions tab, against core's `apps.versions` as the page reaches
// it over RPC (the boundary from the web app), faked: it keeps each
// sealed release's revocation and holds, answers each change with the
// release as it then is, and refuses a reason or hold name core would.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const version = (number: number): AppVersion => ({
  app: appId,
  version: number,
  parent: number === 1 ? null : number - 1,
  tree: `tree-${number}`,
  files: 3,
  author: "user-owner",
  message: `Change ${number}`,
  createdAt: `2026-10-0${number}T09:00:00.000Z`,
  proposedBy: null,
});

const desk: ViewedApp = {
  id: appId,
  name: "Desk",
  description: "",
  owner: "user-owner",
  responsible: "user-owner",
  audience: null,
  blueprint: null,
  currentVersion: 2,
  pendingVersion: 3,
  status: "published",
  process: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  role: "builder",
};

const person = (role: Identity["role"], staff = false): Identity => ({
  userId: "user-ann",
  email: "ann@acme.test",
  name: "Ann",
  role,
  teams: [],
  staff,
  expiresAt: "2026-11-01T09:00:00.000Z",
});

/** Why a change is made, as core takes it, or core's refusal of none. */
const why = (input: unknown): string => {
  const reason =
    typeof input === "object" && input !== null && "reason" in input
      ? String(input.reason).trim()
      : "";
  if (reason === "") {
    throw new Error("That isn't a valid app.");
  }
  return reason;
};

/** Core's versions of an App whose versions 1 and 2 are sealed, and each call asked. */
const fakeVersions = () => {
  const asked: unknown[][] = [];
  const releases = new Map<number, AppRelease>(
    [2, 1].map((number) => [
      number,
      {
        app: appId,
        version: number,
        manifestHash: "a".repeat(64),
        sealedAt: `2026-10-0${number}T09:05:00.000Z`,
        revokedAt: null,
        holds: [],
      },
    ])
  );
  const sealed = (number: number): AppRelease => {
    const release = releases.get(number);
    if (release === undefined) {
      throw new Error("This version isn't sealed.");
    }
    return release;
  };
  const versions = {
    list: async (): Promise<AppVersion[]> => {
      await Promise.resolve();
      return [version(3), version(2), version(1)];
    },
    releases: async (): Promise<AppRelease[]> => {
      await Promise.resolve();
      asked.push(["releases"]);
      return [...releases.values()];
    },
    revoke: async (
      _app: string,
      number: number,
      input: unknown
    ): Promise<AppRelease> => {
      await Promise.resolve();
      asked.push(["revoke", number, why(input)]);
      const release = {
        ...sealed(number),
        revokedAt: "2026-10-30T10:00:00.000Z",
      };
      releases.set(number, release);
      return release;
    },
    placeHold: async (
      _app: string,
      number: number,
      input: unknown
    ): Promise<AppRelease> => {
      await Promise.resolve();
      const reason = why(input);
      const hold =
        typeof input === "object" && input !== null && "hold" in input
          ? String(input.hold)
          : "";
      asked.push(["placeHold", number, hold, reason]);
      const release = sealed(number);
      const held = {
        ...release,
        holds: [
          ...release.holds,
          { hold, placedAt: "2026-10-30T10:00:00.000Z" },
        ],
      };
      releases.set(number, held);
      return held;
    },
    releaseHold: async (
      _app: string,
      number: number,
      hold: string
    ): Promise<AppRelease> => {
      await Promise.resolve();
      asked.push(["releaseHold", number, hold]);
      const release = sealed(number);
      const lifted = {
        ...release,
        holds: release.holds.filter((each) => each.hold !== hold),
      };
      releases.set(number, lifted);
      return lifted;
    },
  };
  return { session: { apps: { versions } }, asked };
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
  session: ReturnType<typeof fakeVersions>["session"],
  viewer: Identity
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <AppVersions app={desk} identity={viewer} />,
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

const press = async (element: Element | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
  );

/** The menu of `number`'s actions, opened: what it offers. */
const menuOf = async (number: number): Promise<string[] | null> => {
  const actions = button(`Actions for version ${number}`);
  if (actions === undefined) {
    return null;
  }
  await press(actions);
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (each) => each.textContent?.trim() ?? ""
  );
};

const menuItem = (name: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (each) => each.textContent?.trim() === name
  );

/** Types `text` into the field labelled `label`. */
const type = async (label: string, text: string): Promise<void> => {
  const field = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  const box = [...document.querySelectorAll("textarea, input")].find(
    (each) => each.id === field?.htmlFor
  );
  if (
    !(box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement)
  ) {
    throw new TypeError(`No field ${label}`);
  }
  const prototype =
    box instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** Each version listed, and what it is marked. */
const listed = (): string[] =>
  [...document.querySelectorAll("tbody tr td:first-child")].map(
    (cell) => cell.textContent?.trim() ?? ""
  );

const disabled = (name: string): boolean | undefined => button(name)?.disabled;

/** What `viewer` is offered for version 1, and what the page asked of core. */
const seenBy = async (viewer: Identity) => {
  const { session, asked } = fakeVersions();
  await shown(session, viewer);
  const menu = await menuOf(1);
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
  return { asked, menu };
};

describe("A domain's releases, revoked or held, for its admins", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("revokes a release only once the admin says why, and shows it revoked", async () => {
    const { session, asked } = fakeVersions();
    await shown(session, person("admin"));

    // Version 3 isn't sealed: there is no release to revoke.
    const unsealed = await menuOf(3);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await Promise.resolve();
    });
    await settled();
    await menuOf(2);
    await press(menuItem("Revoke this version"));
    const withoutReason = disabled("Revoke");
    await type("Why", "It sends invoices to the wrong customer.");
    await press(button("Revoke"));

    expect({
      unsealed,
      withoutReason,
      asked,
      listed: listed(),
    }).toStrictEqual({
      unsealed: ["Make current"],
      withoutReason: true,
      asked: [
        ["releases"],
        ["revoke", 2, "It sends invoices to the wrong customer."],
      ],
      listed: ["3Up for review", "2CurrentRevoked", "1"],
    });
    await expect(menuOf(2)).resolves.toStrictEqual(["Place a legal hold"]);
  });

  it("places a named legal hold with why, then lifts it", async () => {
    const { session, asked } = fakeVersions();
    await shown(session, person("admin"));

    await menuOf(1);
    await press(menuItem("Place a legal hold"));
    await type("Name of the hold, such as a case reference", "CASE-17");
    const withoutReason = disabled("Place hold");
    await type("Why", "Litigation over the March invoices.");
    await press(button("Place hold"));
    const held = listed();
    await menuOf(1);
    await press(menuItem("Lift the legal hold CASE-17"));
    await press(button("Lift hold"));

    expect({ withoutReason, held, asked, lifted: listed() }).toStrictEqual({
      withoutReason: true,
      held: ["3Up for review", "2Current", "1Legal hold: CASE-17"],
      asked: [
        ["releases"],
        ["placeHold", 1, "CASE-17", "Litigation over the March invoices."],
        ["releaseHold", 1, "CASE-17"],
      ],
      lifted: ["3Up for review", "2Current", "1"],
    });
  });

  it("offers no rollback to a version once it is revoked", async () => {
    const { session } = fakeVersions();
    await shown(session, person("admin"));

    const before = await menuOf(1);
    await press(menuItem("Revoke this version"));
    await type("Why", "It leaks the customer list.");
    await press(button("Revoke"));

    expect({ before, after: await menuOf(1) }).toStrictEqual({
      before: [
        "Roll back to this version",
        "Revoke this version",
        "Place a legal hold",
      ],
      after: ["Place a legal hold"],
    });
  });

  it("says so when the releases can't be read, rather than showing none revoked or held", async () => {
    const { session } = fakeVersions();
    session.apps.versions.releases = async (): Promise<AppRelease[]> => {
      await Promise.resolve();
      throw new Error("Grasp couldn't read the releases.");
    };
    await shown(session, person("admin"));

    expect({
      listed: listed(),
      actions: button("Actions for version 1"),
    }).toStrictEqual({ listed: [], actions: undefined });
  });

  it("offers none of it to a builder who isn't an admin, or to Grasp staff", async () => {
    const seen = {
      builder: await seenBy(person("builder")),
      staff: await seenBy(person("admin", true)),
    };

    expect(seen).toStrictEqual({
      builder: { asked: [], menu: ["Roll back to this version"] },
      staff: { asked: [], menu: null },
    });
  });
});

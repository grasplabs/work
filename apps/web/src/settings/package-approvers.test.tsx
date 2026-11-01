// @vitest-environment happy-dom
import type {
  DependencyApprover,
  DependencyApproverSubject,
} from "@grasp-os/shared/dependencies";
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

import { PackageApprovers } from "./package-approvers.tsx";

// Settings › Packages › Who approves packages against core's dependencies,
// members and workflows APIs as the page reaches them over RPC (the
// boundary from the web app), faked: grants are kept as an admin gives and
// takes them away, and the page's next read answers with them, so what the
// page shows after a change is what core holds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const ada = {
  userId: "user-ada",
  name: "Ada Lovelace",
  email: "ada@acme.test",
};
const grace = {
  userId: "user-grace",
  name: "Grace Hopper",
  email: "grace@acme.test",
};
const platform = { id: "team-platform", name: "Platform" };

/** Core as the page reaches it, keeping every grant, and each change asked. */
const fakeCore = (refuse?: string) => {
  const asked: unknown[] = [];
  const grants: DependencyApprover[] = [];
  const nameOf = (subject: DependencyApproverSubject): string | null =>
    subject.type === "team"
      ? platform.name
      : ([ada, grace].find(({ userId }) => userId === subject.userId)?.name ??
        null);
  const dependencies = {
    approvers: async (): Promise<DependencyApprover[]> => {
      await Promise.resolve();
      return grants.map((grant) => ({ ...grant }));
    },
    grantApprover: async (
      subject: DependencyApproverSubject
    ): Promise<DependencyApprover> => {
      await Promise.resolve();
      asked.push(["grant", subject]);
      if (refuse !== undefined) {
        throw new Error(refuse);
      }
      const grant: DependencyApprover = {
        id: `grant-${grants.length + 1}`,
        subject,
        name: nameOf(subject),
        status: "active",
        grantedBy: ada.userId,
        grantedAt: "2026-10-30T10:00:00.000Z",
        revokedBy: null,
        revokedAt: null,
      };
      grants.push(grant);
      return grant;
    },
    revokeApprover: async (id: string): Promise<DependencyApprover> => {
      await Promise.resolve();
      asked.push(["revoke", id]);
      const grant = grants.find((each) => each.id === id);
      if (grant === undefined) {
        throw new Error("There's no such dependency request.");
      }
      grant.status = "revoked";
      return grant;
    },
  };
  const members = {
    list: async () => {
      await Promise.resolve();
      return [grace, ada];
    },
  };
  const workflows = {
    teams: async () => {
      await Promise.resolve();
      return [platform];
    },
  };
  return { session: { dependencies, members, workflows }, asked };
};

let root: Root | undefined;

/** The section on what `session` holds, for an admin who may change it when `editable`. */
const shown = async (
  session: ReturnType<typeof fakeCore>["session"],
  editable = true
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({
    loader: async () => await session.dependencies.approvers(),
    component: () => (
      <PackageApprovers
        approvers={rootRoute.useLoaderData()}
        editable={editable}
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
};

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

const press = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent?.trim() === name
  );

/** Opens the list of who can be added and picks `name` from it. */
const add = async (name: string) => {
  await press(button("Add approver"));
  await press(
    [...document.querySelectorAll('[role="option"]')].find(
      // A person's line starts with their initials.
      (each) => each.textContent?.trim().endsWith(name)
    )
  );
};

/** Who the table lists, and as what. */
const listed = (): string[][] =>
  [...document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .slice(0, 2)
      .map((cell) => cell.textContent?.trim() ?? "")
  );

/** The names offered when the list of who can be added opens. */
const offered = async (): Promise<string[]> => {
  await press(button("Add approver"));
  const names = [...document.querySelectorAll('[role="option"]')].map(
    (each) => each.textContent?.trim() ?? ""
  );
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await Promise.resolve();
  });
  await settled();
  return names;
};

describe("Settings › Packages › Who approves packages", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets an admin give a person and a team the permission, offer only who lacks it, and take it away", async () => {
    const { session, asked } = fakeCore();
    await shown(session);
    expect(document.body.textContent).toContain("Nobody approves packages yet");

    await add("Grace Hopper");
    await add("Platform");
    expect(listed()).toStrictEqual([
      ["Grace Hopper", "Person"],
      ["Platform", "Team"],
    ]);
    await expect(offered()).resolves.toStrictEqual([
      expect.stringContaining("Ada Lovelace"),
    ]);

    await press(button("Remove Grace Hopper as an approver"));
    expect({ asked, listed: listed() }).toStrictEqual({
      asked: [
        ["grant", { type: "person", userId: grace.userId }],
        ["grant", { type: "team", teamId: platform.id }],
        ["revoke", "grant-1"],
      ],
      listed: [["Platform", "Team"]],
    });
  });

  it("says why core refused a grant, and lists nobody new", async () => {
    const { session } = fakeCore(
      "Only an admin of the organization can do this."
    );
    await shown(session);

    await add("Ada Lovelace");

    expect(document.body.textContent).toContain(
      "Only an admin of the organization can do this."
    );
    expect(listed()).toStrictEqual([]);
  });

  it("shows Grasp staff who approves, with nothing they can change", async () => {
    const { session } = fakeCore();
    await session.dependencies.grantApprover({
      type: "person",
      userId: ada.userId,
    });
    await shown(session, false);

    expect({
      listed: listed(),
      add: button("Add approver"),
      remove: button("Remove Ada Lovelace as an approver"),
    }).toStrictEqual({
      listed: [["Ada Lovelace", "Person"]],
      add: undefined,
      remove: undefined,
    });
  });
});

// @vitest-environment happy-dom
import type { Identity } from "@grasp-os/shared/rpc";
import type { MigrationSample, SampleMigration } from "@grasp-os/shared/stores";
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

import { MigrationSampleControl } from "./migration-sample.tsx";

// The way to dry-run a version's migration on real records, from its
// review, against core's stores as the page reaches them over RPC, faked:
// only the organization's own admins are offered it, never Grasp staff or
// a builder; it asks core for exactly the review's version and migration,
// and says what the sample found, or why core refused it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const sampleOf = (changes: Partial<MigrationSample>): MigrationSample => ({
  id: "sample-1",
  app: "app-1",
  version: 4,
  migration: "notes-v2",
  store: "store-1",
  outcome: "passed",
  rows: 20,
  owners: 3,
  sampledAt: "2026-10-30T10:00:00.000Z",
  failure: null,
  ...changes,
});

/**
 * The control in a page signed in as `identity`, with core answering each
 * sample as `answers` says, in turn: what it was asked.
 */
const shown = async (
  identity: Pick<Identity, "role" | "staff">,
  answers: (() => MigrationSample)[] = []
) => {
  const asked: SampleMigration[] = [];
  const stores = {
    sampleMigration: async (input: SampleMigration) => {
      await Promise.resolve();
      asked.push(input);
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error("No answer");
      }
      return answer();
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { stores: typeof stores }) => Promise<T>
    ): Promise<T> => await action({ stores }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <MigrationSampleControl app="app-1" migration="notes-v2" version={4} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core, identity },
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
  return { asked };
};

/** Presses the button that says `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent === label
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};

const text = (): string => document.body.textContent;

const admin = { role: "admin", staff: false } as const;

describe(MigrationSampleControl, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("asks core for the review's own version and migration, and says what each sample found", async () => {
    const { asked } = await shown(admin, [
      () => sampleOf({ outcome: "passed", rows: 20 }),
      () =>
        sampleOf({
          outcome: "failed",
          failure: {
            record: "rec-7",
            reason: "invalid_output",
            issues: ["title: expected a string"],
          },
        }),
      () => sampleOf({ outcome: "empty", rows: 0 }),
    ]);
    const before = text();

    await press("Try it on real records");
    const passed = text();
    await press("Try it again");
    const failed = text();
    await press("Try it again");
    const empty = text();

    expect({ before, passed, failed, empty, asked }).toStrictEqual({
      before: "Try it on real records",
      passed: "Try it againPassed on 20 real records",
      failed:
        "Try it againIt failed on the record rec-7. This version can't be made current until a newer sample passes.title: expected a string",
      empty: "Try it againNo records are left for it to transform.",
      asked: Array.from({ length: 3 }, () => ({
        app: "app-1",
        version: 4,
        migration: "notes-v2",
      })),
    });
  });

  it("says why core refused a sample", async () => {
    await shown(admin, [
      () => {
        throw new Error("Only admins may sample a migration");
      },
    ]);

    await press("Try it on real records");

    expect(text()).toContain("Only admins may sample a migration");
  });

  it.each([
    ["a builder", { role: "builder", staff: false }],
    ["a user", { role: "user", staff: false }],
    ["Grasp staff", { role: "admin", staff: true }],
  ] as const)("isn't offered to %s", async (_who, identity) => {
    await shown(identity);

    expect(text()).toBe("");
  });
});

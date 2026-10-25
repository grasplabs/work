// @vitest-environment happy-dom
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

import { MemoryPage } from "./memory-page.tsx";

// The Brain's memory page, against core's knowledge API as the page
// reaches it over RPC, faked: a person corrects their own record against
// the revision they read, and sees the correction in its place; another's
// shared record offers no correction, and a retirement only to an admin;
// a refusal is said and nothing is taken as done.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const recordedAt = "2026-10-20T09:00:00.000Z";

const record = (
  id: string,
  statement: string,
  scope: "person" | "team" = "person",
  by: string | null = null
) => ({
  id,
  revision: 1,
  kind: "fact" as const,
  scope,
  statement,
  sourceRefs: [],
  state: "accepted" as const,
  validFrom: null,
  validTo: null,
  recordedAt,
  reviewAt: null,
  by,
});

const own = record("m-own", "Floor 3 is quiet.");
const shared = record("m-team", "Stand-ups are at nine.", "team", "Ben");

/** Shows the page to an admin or not, on a core refusing what `refusal` says. */
const shown = async (admin: boolean, refusal?: string) => {
  const calls: string[] = [];
  const records = { mine: [own], shared: [shared] };
  const retired = new Set<string>();
  const knowledge = {
    memoriesList: async ({ among }: { among: "mine" | "shared" }) => {
      await Promise.resolve();
      calls.push(`list ${among}`);
      return { records: records[among], cursor: null };
    },
    memoriesLineage: async ({ memoryId }: { memoryId: string }) => {
      await Promise.resolve();
      calls.push(`lineage ${memoryId}`);
      const known =
        [own, shared].find(({ id }) => id === memoryId) ??
        record(memoryId, "Floor 4 is quiet.");
      const found = retired.has(memoryId)
        ? { ...known, state: "retired" as const, revision: 2 }
        : known;
      return {
        record: found,
        restsOn:
          found.id === own.id
            ? [
                {
                  kind: "document" as const,
                  citedBy: own.id,
                  documentId: "d-1",
                  collectionId: "c-1",
                  version: 1,
                  title: "Office guide",
                  path: "office.md",
                  currentVersion: 2,
                },
              ]
            : [],
        supersededBy: null,
      };
    },
    memoriesProposeChange: async (
      input: { memoryId: string; statement: string },
      options: { expectedRevision: number }
    ) => {
      await Promise.resolve();
      calls.push(
        `correct ${input.memoryId}@${options.expectedRevision}: ${input.statement}`
      );
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
      return { resourceRefs: [{ kind: "memory", memoryId: "m-new" }] };
    },
    memoriesRetire: async (input: { memoryId: string }) => {
      await Promise.resolve();
      calls.push(`retire ${input.memoryId}`);
      retired.add(input.memoryId);
      return { resourceRefs: [{ kind: "memory", memoryId: input.memoryId }] };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { knowledge: typeof knowledge }) => Promise<T>
    ): Promise<T> => await action({ knowledge }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <MemoryPage admin={admin} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
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
  return { calls };
};

/** Lets every pending read settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** Presses the button whose text starts with `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find((each) =>
    each.textContent.startsWith(label)
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** Replaces the correction box's text with `text`. */
const write = async (text: string): Promise<void> => {
  const box = document.querySelector("textarea");
  if (!box) {
    throw new TypeError("No correction box");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** The buttons shown, by text. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map((each) => each.textContent);

describe(MemoryPage, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("corrects a person's own record against the revision read, and shows the correction in its place", async () => {
    const { calls } = await shown(false);
    await settle();
    await press(own.statement);
    const lineage = document.body.textContent;
    await write("Floor 4 is quiet.");
    await press("Save the correction");

    expect({
      restsOn: lineage.includes("Office guide"),
      newer: lineage.includes("it is at version 2 now"),
      calls,
    }).toStrictEqual({
      restsOn: true,
      newer: true,
      calls: [
        "list mine",
        "lineage m-own",
        "correct m-own@1: Floor 4 is quiet.",
        "list mine",
        "lineage m-new",
      ],
    });
  });

  it("offers no correction of another's shared record, and its retirement only to an admin", async () => {
    await shown(false);
    await settle();
    await press("Shared with you");
    await press(shared.statement);
    const member = buttons();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const { calls } = await shown(true);
    await settle();
    await press("Shared with you");
    await press(shared.statement);
    await press("Retire it");
    const afterRetire = buttons();

    expect({
      member: member.filter(
        (label) => label === "Retire it" || label === "Save the correction"
      ),
      textarea: document.querySelector("textarea") === null,
      calls: calls.filter((call) => call.startsWith("retire")),
      // Read again after the retirement, as it is now.
      lineageReads: calls.filter((call) => call === "lineage m-team").length,
      retireStillOffered: afterRetire.includes("Retire it"),
    }).toStrictEqual({
      member: [],
      textarea: true,
      calls: ["retire m-team"],
      lineageReads: 2,
      retireStillOffered: false,
    });
  });

  it("says why core refused a correction, and keeps the record as it was", async () => {
    const refusal =
      "This changed since it was read. Read it again and apply the change to the latest revision.";
    const { calls } = await shown(false, refusal);
    await settle();
    await press(own.statement);
    await write("Floor 5.");
    await press("Save the correction");

    expect({
      said: document.body.textContent.includes(refusal),
      readAgain: calls.filter((call) => call.startsWith("list")).length,
      stillOpen: calls.at(-1),
    }).toStrictEqual({
      said: true,
      readAgain: 1,
      stillOpen: "correct m-own@1: Floor 5.",
    });
  });
});

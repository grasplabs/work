// @vitest-environment happy-dom
import type { AuditEvent } from "@grasp-os/shared/audit";
import type {
  AuditFilter,
  AuditPage,
  AuditRecord,
} from "@grasp-os/shared/audit-log";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EventInspector } from "./audit-event.tsx";
import { LogRecords } from "./audit-log.tsx";

// The audit trail's events as an admin pages through them: 25 a page,
// Newer and Older, Older reading core's next page only once this one needs
// it; and an event's details, its position, check and hash, in the panel
// the page opens beside the table.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A record at `seq`, done by the system. */
const record = (seq: number): AuditRecord => {
  const event: AuditEvent = {
    id: `event-${seq}`,
    at: "2026-01-05T10:00:00.000Z",
    source: "core",
    actor: { type: "system" },
    action: "test.done",
    provenance: [],
    detail: {},
  };
  return {
    seq,
    receivedAt: "2026-01-05T10:00:00.000Z",
    eventJson: JSON.stringify(event),
    event,
    type: "action",
    version: 1,
    prevHash: `h${seq - 1}`,
    hash: `hash-of-${seq}`,
    verified: true,
  };
};

/** Records `from` down to `to`, newest first. */
const records = (from: number, to: number): AuditRecord[] =>
  Array.from({ length: from - to + 1 }, (_, at) => record(from - at));

let root: Root | undefined;

const directory = { people: new Map(), teams: new Map(), apps: new Map() };

/** The events, and the details of the one opened, as the audit trail's page holds them. */
const Events = ({ first, archive }: { first: AuditPage; archive: boolean }) => {
  const [open, setOpen] = useState<AuditRecord>();
  return (
    <>
      <LogRecords
        directory={directory}
        first={first}
        onDetails={setOpen}
        search={archive ? { archive } : {}}
      />
      {open === undefined ? null : (
        <EventInspector
          archive={archive}
          directory={directory}
          framed
          record={open}
        />
      )}
    </>
  );
};

/** The audit trail's filters the page went to last, by the router. */
let went: () => Record<string, unknown> = () => ({});

/**
 * The events, core's first page `first`, and its older pages from `older`:
 * the log's, or the archive's.
 */
const shown = async (
  first: AuditPage,
  older: (before: number) => AuditPage,
  archive = false
): Promise<number[]> => {
  const asked: number[] = [];
  const session = {
    audit: {
      search: async (_filter?: AuditFilter, before?: number) => {
        await Promise.resolve();
        if (before !== undefined) {
          asked.push(before);
        }
        return before === undefined ? first : older(before);
      },
    },
  };
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const created = createRouter({
    routeTree: createRootRoute({
      component: () => <Events archive={archive} first={first} />,
    }),
    history: createMemoryHistory(),
    context: { core },
  });
  went = () => ({ ...created.state.location.search });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={created} />
      </I18nProvider>
    );
    await created.load();
  });
  return asked;
};

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
  );
  if (found === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

const press = async (name: string): Promise<void> => {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
  await settled();
};

/** The page of events shown: the range it says, and how many rows. */
const page = () => ({
  range: document.querySelector('nav[aria-label="Pages of events"]')
    ?.firstElementChild?.textContent,
  rows: document.querySelectorAll("tbody tr").length,
});

/** What the event's details panel says. */
const panel = (): string =>
  document.querySelector('[aria-label="Event details"]')?.textContent ?? "";

describe(LogRecords, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    went = () => ({});
    document.body.innerHTML = "";
  });

  it("shows 25 events a page, reading core's next page only once Older needs it", async () => {
    const asked = await shown({ records: records(40, 1), next: null }, () => ({
      records: [],
      next: null,
    }));
    const first = page();
    await press("Older");
    const second = page();
    const olderAtEnd = button("Older").disabled;
    await press("Newer");

    expect({ first, second, olderAtEnd, back: page(), asked }).toStrictEqual({
      first: { range: "1–25", rows: 25 },
      second: { range: "26–40", rows: 15 },
      olderAtEnd: true,
      back: { range: "1–25", rows: 25 },
      asked: [],
    });
  });

  it("reads on in core until there is a page past this one, filling this one meanwhile", async () => {
    const asked = await shown(
      { records: records(100, 91), next: 91 },
      (before) =>
        before === 91
          ? { records: records(90, 81), next: 81 }
          : { records: records(80, 71), next: null }
    );
    await press("Older");

    expect({ asked, page: page() }).toStrictEqual({
      asked: [91, 81],
      page: { range: "26–30", rows: 5 },
    });
  });

  it("opens an event's details beside the table: what happened, and its place in the chain under Integrity", async () => {
    await shown({ records: records(3, 1), next: null }, () => ({
      records: [],
      next: null,
    }));
    await press("Details of event 2");
    const open = panel();

    expect({
      what: open.includes("test.done"),
      action: open.includes("Actiontest.done"),
      position: open.includes("Position2"),
      verified: open.includes("Yes: it is unchanged"),
      hash: open.includes("hash-of-2"),
    }).toStrictEqual({
      what: true,
      action: true,
      position: true,
      verified: true,
      hash: true,
    });
  });

  it("keeps to the archive when an archived event's details search on: their events, similar ones, what it was about", async () => {
    const person: AuditRecord = {
      ...record(7),
      event: {
        id: "event-7",
        at: "2026-01-05T10:00:00.000Z",
        source: "core",
        actor: { type: "person", userId: "user-1" },
        action: "project.created",
        target: { type: "project", id: "project-1" },
        provenance: [],
        detail: { name: "Launch" },
      },
    };
    await shown(
      { records: [person], next: null },
      () => ({ records: [], next: null }),
      true
    );
    await press("Details of event 7");
    const searches: unknown[] = [];
    for (const name of ["Their events", "Find similar"]) {
      // oxlint-disable-next-line no-await-in-loop -- one search after the other
      await press(name);
      searches.push(went());
    }
    // What it was about: the About list's row, named by the target's ID.
    const about = document.querySelector('[aria-label="About"] button');
    await act(async () => {
      if (about instanceof HTMLElement) {
        about.click();
      }
      await Promise.resolve();
    });
    await settled();
    searches.push(went());

    expect(searches).toStrictEqual([
      { actor: "user-1", archive: true },
      { action: "project.created", archive: true },
      { target: "project-1", archive: true },
    ]);
  });
});

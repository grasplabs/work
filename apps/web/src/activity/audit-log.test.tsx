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

const directory = { people: new Map(), apps: new Map() };

/** The events, and the details of the one opened, as the audit trail's page holds them. */
const Events = ({ first }: { first: AuditPage }) => {
  const [open, setOpen] = useState<AuditRecord>();
  return (
    <>
      <LogRecords
        directory={directory}
        first={first}
        onDetails={setOpen}
        search={{}}
      />
      {open === undefined ? null : (
        <EventInspector directory={directory} framed record={open} />
      )}
    </>
  );
};

/** The events, core's first page `first`, and its older pages from `older`. */
const shown = async (
  first: AuditPage,
  older: (before: number) => AuditPage
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
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Events first={first} />,
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
  range: document.querySelector('nav[aria-label="Pages of events"] p')
    ?.textContent,
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
    const folded = panel();
    await press("Integrity");
    const open = panel();

    expect({
      what: folded.includes("test.done"),
      action: open.includes("test.done"),
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
});

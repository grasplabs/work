// @vitest-environment happy-dom
import type { AuditEvent } from "@grasp-os/shared/audit";
import type {
  AuditFilter,
  AuditPage,
  AuditRecord,
  AuditRetention,
} from "@grasp-os/shared/audit-log";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AuditArchive } from "./audit-archive.tsx";

// Settings › Audit trail › Archived events and Retention against core's
// audit API as the page reaches it over RPC (the boundary from the web
// app), faked: an archive of `stretches`, newest first, a stretch per
// page as core reads it, filtered by action, and the deployment's
// retention.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** An archived record at `seq`, of `action`. */
const archived = (seq: number, action: string): AuditRecord => {
  const event: AuditEvent = {
    id: `event-${seq}`,
    at: "2026-01-05T10:00:00.000Z",
    source: "core",
    actor: { type: "system" },
    action,
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
    hash: `h${seq}`,
    verified: true,
  };
};

/** Core's audit API: an archive in stretches, and the deployment's retention. */
const fakeAudit = ({
  stretches,
  retention,
}: {
  stretches: AuditRecord[][];
  retention: AuditRetention;
}) => {
  const asked: { action?: string; before?: number }[] = [];
  const audit = {
    searchArchive: async (
      filter?: AuditFilter,
      before?: number
    ): Promise<AuditPage> => {
      await Promise.resolve();
      asked.push({ action: filter?.action, before });
      const index =
        before === undefined
          ? 0
          : stretches.findIndex((stretch) =>
              stretch.every(({ seq }) => seq < before)
            );
      const stretch = stretches[index] ?? [];
      const older = stretches[index + 1];
      return {
        records: stretch.filter(
          ({ event }) =>
            filter?.action === undefined || event?.action === filter.action
        ),
        next: older === undefined ? null : (stretch.at(-1)?.seq ?? null),
      };
    },
    retention: async (): Promise<AuditRetention> => {
      await Promise.resolve();
      return retention;
    },
  };
  return { session: { audit }, asked };
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

const shown = async (
  session: ReturnType<typeof fakeAudit>["session"],
  action?: string
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <AuditArchive
        directory={{ people: new Map(), apps: new Map() }}
        search={action === undefined ? {} : { action }}
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

/** The entries listed, by the action each names. */
const listed = (): number =>
  document.querySelectorAll('ul[aria-label="Entries"] > li').length;

const text = (): string => document.body.textContent ?? "";

const kept: AuditRetention = { auditDays: 180, archiveDays: 2555, runDays: 30 };

describe("Settings › Audit trail › Archive and retention", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("searches the archive only when asked, with the page's filters, and pages through it a stretch at a time", async () => {
    const { session, asked } = fakeAudit({
      stretches: [
        [archived(7, "test.c"), archived(6, "test.b")],
        [archived(3, "test.c"), archived(2, "test.b")],
      ],
      retention: kept,
    });
    await shown(session, "test.b");
    const before = asked.length;

    await press("Search the archive");
    const first = listed();
    await press("Load older");

    expect({ before, asked, first, older: listed() }).toStrictEqual({
      before: 0,
      asked: [
        { action: "test.b", before: undefined },
        { action: "test.b", before: 6 },
      ],
      first: 1,
      older: 2,
    });
  });

  it("downloads the audit trail with its archive, filtered as shown, as CSV or JSON", async () => {
    const { session } = fakeAudit({ stretches: [], retention: kept });
    await shown(session, "test.b");
    const opened: string[] = [];
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation((url: string | URL) => {
        opened.push(String(url));
      });
    try {
      for (const format of ["CSV", "JSON"]) {
        // oxlint-disable-next-line no-await-in-loop -- one menu at a time
        await press("Export with archive");
        const item = [...document.querySelectorAll('[role="menuitem"]')].find(
          (each) => each.textContent?.trim() === `Export ${format}`
        );
        // oxlint-disable-next-line no-await-in-loop -- as above
        await act(async () => {
          if (item instanceof HTMLElement) {
            item.click();
          }
          await Promise.resolve();
        });
      }
    } finally {
      assign.mockRestore();
    }

    expect(opened).toStrictEqual([
      "/api/audit/export?format=csv&archive=1&action=test.b",
      "/api/audit/export?format=json&archive=1&action=test.b",
    ]);
  });

  it("shows how long Grasp keeps events and run details", async () => {
    const { session } = fakeAudit({ stretches: [], retention: kept });
    await shown(session);

    expect({
      text: text().includes("180 days"),
      archive: text().includes("2555 days") || text().includes("2,555 days"),
      runs: text().includes("30 days"),
    }).toStrictEqual({ text: true, archive: true, runs: true });
  });
});

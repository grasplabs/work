/**
 * The apps companies asked Grasp to add, as their cores say it (the
 * snapshot's `asked`, core's app requests): one per app across every
 * company, so an app asked for at three companies is listed once.
 */
import type { AskedApp as ToolApp } from "@grasp-os/shared/admin/admin-integrations";

import type { ClientAdmin } from "../clients/admin.ts";

/** One company's request for an app. */
export interface AppAsk {
  /** The client, by its id. */
  org: string;
  /** Its name, as the admin knows it. */
  orgName: string;
  /** When it asked first. */
  on: string;
}

/** An app asked of Grasp, by however many companies. */
export interface AskedApp {
  /** What the app is known by in the admin's links: its name in lower case, words joined by dashes. */
  key: string;
  /** Its name, as the first company to ask for it wrote it. */
  name: string;
  /** The companies that asked, in the order they asked. */
  asks: AppAsk[];
}

const notWord = /[^\p{L}\p{N}]+/gu;
const edgeDashes = /^-+|-+$/gu;

/** An app's key from its name: the same app asked as "Exact Online" and "exact  online" is one. */
export const appKey = (name: string): string =>
  name.toLowerCase().replaceAll(notWord, "-").replaceAll(edgeDashes, "");

/**
 * Every app the answered companies asked for, once each: the app the most
 * companies asked for first, then the one asked for longest ago
 * (`sortAsked`). A company whose core
 * didn't answer says nothing here.
 */
export const askedApps = (admins: readonly ClientAdmin[]): AskedApp[] => {
  const apps = new Map<string, AskedApp>();
  const ordered = admins
    .flatMap((admin) =>
      admin.state === "answered"
        ? admin.snapshot.asked.map((app) => ({
            key: appKey(app.name),
            name: app.name,
            ask: {
              org: admin.client.id,
              orgName: admin.client.name,
              on: app.askedAt,
            },
          }))
        : []
    )
    .filter(({ key }) => key !== "")
    .toSorted((a, b) => a.ask.on.localeCompare(b.ask.on));
  for (const { key, name, ask } of ordered) {
    const app = apps.get(key) ?? { key, name, asks: [] };
    // A company that asked twice, as two spellings, asked once.
    if (!app.asks.some((each) => each.org === ask.org)) {
      app.asks.push(ask);
    }
    apps.set(key, app);
  }
  return [...apps.values()].toSorted(
    (a, b) =>
      b.asks.length - a.asks.length ||
      (a.asks[0]?.on ?? "").localeCompare(b.asks[0]?.on ?? "") ||
      a.name.localeCompare(b.name)
  );
};

/**
 * Every app asked for (`askedApps`), as the admin's MCP answers it
 * (`apps_asked`), in the order the page lists them, so the two can't say
 * different things. An app is known by an id that says nothing a company
 * wrote, `asked-<n>`; its name, as a company wrote it, is data beside it.
 */
export const appsAsked = (admins: readonly ClientAdmin[]): ToolApp[] =>
  askedApps(admins).map((app, index) => ({
    id: `asked-${index + 1}`,
    app: app.name,
    requests: app.asks.map(({ org, on }) => ({ org, on })),
  }));

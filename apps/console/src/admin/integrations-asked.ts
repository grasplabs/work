/**
 * The apps companies asked Grasp to add, as their cores say it (the
 * snapshot's `asked`, core's app requests): one per app across every
 * company, so an app asked for at three companies is built once. This is
 * where an integration to build starts, at its first step, asked for
 * (`BUILD_STAGES`); the build itself, from Build it on, is the console's
 * own record (GRA-689), which these rows meet by `key`.
 */
import type { ClientAdmin } from "../clients/admin.ts";

/** One company's request for an app. */
export interface AppAsk {
  /** The client, by its id. */
  org: string;
  /** Its name, as the console knows it. */
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
 * companies asked for first, then the one asked for longest ago, as the
 * prototype sorts what waits on Grasp (`sortBuilds`). A company whose core
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

import type { App, AppContents } from "@grasp-os/shared/apps";

import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";
import { openableApps } from "../workflows/reads.ts";

// The domains (core's Apps) the person can open, each with what its
// current version holds: for the Domains page's cards and the Apps page's
// screens. Core has no one read of every domain's contents, so it is one
// `apps.contents` per domain, side by side.

export interface ListedDomain {
  app: App;
  /** Undefined when core didn't answer for this domain. */
  contents?: AppContents;
}

/**
 * How long one domain's contents may take: half the page's own limit, so
 * a domain whose read hangs costs only its own part, never the whole list.
 */
const contentsTimeoutMs = timeoutMs / 2;

export const listDomains = async (
  session: Session
): Promise<ListedDomain[]> => {
  const apps = await openableApps(session);
  // One domain whose contents can't be read (a damaged version, a read
  // that hangs) still leaves the others, and its own part.
  const contents = await Promise.allSettled(
    apps.map(
      async (app) =>
        await withTimeout(session.apps.contents(app.id), contentsTimeoutMs)
    )
  );
  return apps.map((app, index) => {
    const read = contents[index];
    return read?.status === "fulfilled"
      ? { app, contents: read.value }
      : { app };
  });
};

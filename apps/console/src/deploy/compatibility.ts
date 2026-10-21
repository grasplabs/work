/**
 * Whether a client can go from the releases its Workers run to another,
 * by what each release declares its code works with
 * (`releaseCompatibilitySchema`, spec 40.3 and 40.4). A client's Workers
 * switch one at a time, so after each switch every Worker that calls
 * another must call the version that one serves: a deploy that stops
 * halfway leaves the client in one of those states. And the release
 * must read every workflow journal, and run every App release, the code
 * it replaces may have left.
 *
 * A release that declares nothing isn't made live. A Worker still on one
 * is checked only as far as the release that replaces it declares: an
 * undeclared release says nothing to check against.
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { eq } from "drizzle-orm";

import type { ConsoleDatabase } from "../db/act.ts";
import { clientWorkers } from "../db/schema.ts";
import { importedManifest } from "./release.ts";

/** Why a client can't go to a release: a code, and our own words for it. */
export interface Incompatibility {
  code: "release_undeclared" | "release_incompatible";
  message: string;
}

interface Range {
  min: number;
  max: number;
}

const covers = (outer: Range, inner: Range): boolean =>
  outer.min <= inner.min && inner.max <= outer.max;

const describe = ({ min, max }: Range): string =>
  min === max ? String(min) : `${min}–${max}`;

/** The first call in `running` a caller makes of a version it doesn't call. */
const brokenCall = (
  running: ReadonlyMap<string, ReleaseManifest | null>
): string | null => {
  for (const [caller, release] of running) {
    const calls = release?.compatibility?.interfaces[caller]?.calls ?? {};
    for (const [callee, range] of Object.entries(calls)) {
      const served = running.get(callee);
      // Nothing runs there yet, or it runs a release that declares nothing.
      if (served?.compatibility === undefined) {
        continue;
      }
      const version = served.compatibility.interfaces[callee]?.serves;
      if (version === undefined || version < range.min || version > range.max) {
        return `${caller} of ${release?.releaseId ?? ""} calls ${callee} ${describe(range)}, but ${callee} of ${served.releaseId} serves ${version ?? "none"}`;
      }
    }
  }
  return null;
};

/** What `target` doesn't read or run of what `current` may have left. */
const unreadState = (
  current: ReleaseManifest,
  target: ReleaseManifest
): string | null => {
  const from = current.compatibility;
  const to = target.compatibility;
  if (from === undefined || to === undefined) {
    return null;
  }
  if (!covers(to.workflowJournal, from.workflowJournal)) {
    return `${target.releaseId} reads workflow journals ${describe(to.workflowJournal)}, but ${current.releaseId} may have left ${describe(from.workflowJournal)}`;
  }
  if (!covers(to.sdkProtocols, from.sdkProtocols)) {
    return `${target.releaseId} runs Apps of SDK protocol ${describe(to.sdkProtocols)}, but ${current.releaseId} ran ${describe(from.sdkProtocols)}`;
  }
  return null;
};

/**
 * Why a client whose Workers run `current` (by app; null where none runs
 * yet) can't switch them to `target` one at a time in `order`, or null
 * when it can. A client that runs `target` everywhere already changes no
 * code, so it always can (a deploy of new secrets or settings).
 */
export const incompatibility = (
  current: ReadonlyMap<string, ReleaseManifest | null>,
  target: ReleaseManifest,
  order: readonly string[]
): Incompatibility | null => {
  if (order.every((app) => current.get(app)?.releaseId === target.releaseId)) {
    return null;
  }
  if (target.compatibility === undefined) {
    return {
      code: "release_undeclared",
      message: `${target.releaseId} declares nothing of what its code works with`,
    };
  }
  for (const release of new Set(current.values())) {
    const unread = release === null ? null : unreadState(release, target);
    if (unread !== null) {
      return { code: "release_incompatible", message: unread };
    }
  }
  const running = new Map(current);
  for (const app of order) {
    running.set(app, target);
    const broken = brokenCall(running);
    if (broken !== null) {
      return { code: "release_incompatible", message: broken };
    }
  }
  return null;
};

/**
 * The release each of client `clientId`'s Workers runs, by app, as its
 * record says: null for one that records none.
 */
export const currentReleases = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<Map<string, ReleaseManifest | null>> => {
  const workers = await db
    .select({ app: clientWorkers.worker, releaseId: clientWorkers.releaseId })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  return new Map(
    await Promise.all(
      workers.map(
        async ({
          app,
          releaseId,
        }): Promise<[string, ReleaseManifest | null]> => [
          app,
          releaseId === null ? null : await importedManifest(db, releaseId),
        ]
      )
    )
  );
};

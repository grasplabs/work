/**
 * Whether a client can go from the releases its Workers run to another,
 * by what each release declares its code works with
 * (`releaseCompatibilitySchema`, spec 40.3 and 40.4). A client's Workers
 * switch one at a time, so after each switch every Worker that calls
 * another must call the version that one serves: a deploy that stops
 * halfway leaves the client in one of those states. And the release
 * must read every workflow journal, and run every App release, the code
 * it replaces may have left, and its code must run on each database's
 * schema as the client's migrations left it.
 *
 * A release that declares nothing isn't made live. A Worker still on one
 * is checked only as far as the release that replaces it declares: an
 * undeclared release says nothing to check against. Schemas are checked
 * only between releases that declare them: for a release built before
 * they did, the old rule holds, migrations only expanding for the release
 * before, and a rollback going back no further (src/rollout/rollback.ts).
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import {
  clientDeploys,
  clientProvisions,
  clientWorkers,
  releases,
} from "../db/schema.ts";
import { importedManifest } from "./release.ts";

/** Why a client can't go to a release: a code, and our own words for it. */
export interface Incompatibility {
  code: "release_undeclared" | "release_incompatible" | "schema_incompatible";
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

/** A migration's number as its file name has it: `0016`. */
const migration = (number: number): string => String(number).padStart(4, "0");

/**
 * The first database whose schema, as `applied` left it, doesn't run
 * `target`'s code: one of its migrations raised the oldest schema whose
 * code runs on it past the one `target` needs.
 */
const contractedSchema = (
  applied: Iterable<ReleaseManifest | null>,
  target: ReleaseManifest
): string | null => {
  const needs = target.compatibility?.databases;
  if (needs === undefined) {
    return null;
  }
  for (const release of applied) {
    const left = release?.compatibility?.databases ?? {};
    for (const [name, { schema, compatibleFrom }] of Object.entries(left)) {
      const own = needs[name]?.schema;
      if (own !== undefined && own < compatibleFrom) {
        return `${target.releaseId} needs ${name} at migration ${migration(own)}, but ${release?.releaseId ?? ""} took it to ${migration(schema)}, which runs code from migration ${migration(compatibleFrom)} on`;
      }
    }
  }
  return null;
};

/**
 * Why a client whose Workers run `current` (by app; null where none runs
 * yet), and whose databases' schemas are as `applied` left them
 * (`appliedSchema`; null when none is known), can't switch its Workers to
 * `target` one at a time in `order`, or null when it can. A client that
 * runs `target` everywhere already changes no code, so it always can (a
 * deploy of new secrets or settings).
 */
export const incompatibility = (
  current: ReadonlyMap<string, ReleaseManifest | null>,
  target: ReleaseManifest,
  order: readonly string[],
  applied: ReleaseManifest | null
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
  // The releases the client runs applied their migrations too, so their
  // schemas count, whatever the client's deploy records say.
  const contracted = contractedSchema(
    new Set([applied, ...current.values()]),
    target
  );
  if (contracted !== null) {
    return { code: "schema_incompatible", message: contracted };
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
  db: AdminDatabase,
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

/**
 * The release whose schemas client `clientId`'s databases are at, as its
 * records tell: the newest-built release a deploy or its operation may
 * have run the migrations of (one that finished a step before them, or
 * that the operation recorded before running them, whatever it did
 * after); null when none did. Its databases may be at a newer schema than
 * the release its Workers run, after a rollback. Releases are built from
 * `main` in order, so a newer one ships every migration an older one
 * does, and its schemas run code from no older migration.
 */
export const appliedSchema = async (
  db: AdminDatabase,
  clientId: string
): Promise<ReleaseManifest | null> => {
  const deployed = db
    .select({ releaseId: clientDeploys.releaseId })
    .from(clientDeploys)
    .where(
      and(eq(clientDeploys.clientId, clientId), isNotNull(clientDeploys.step))
    );
  const provisioned = db
    .select({ releaseId: clientProvisions.releaseId })
    .from(clientProvisions)
    .where(
      and(
        eq(clientProvisions.clientId, clientId),
        isNotNull(clientProvisions.step),
        ne(clientProvisions.step, "validated")
      )
    );
  // What its operation recorded before it last ran migrations, kept across
  // releases (src/hosting/operation.ts `schema`).
  const recorded = db
    .select({
      releaseId: sql<string>`json_extract(${clientProvisions.progress}, '$.schema')`,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId));
  const [newest] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(
      or(
        inArray(releases.id, deployed),
        inArray(releases.id, provisioned),
        inArray(releases.id, recorded)
      )
    )
    .orderBy(desc(releases.builtAt))
    .limit(1);
  return newest === undefined ? null : await importedManifest(db, newest.id);
};

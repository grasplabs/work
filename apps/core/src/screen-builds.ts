import { compilerVersion } from "@grasp-os/compiler";
import { createAuditEvent } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { screenPath } from "@grasp-os/shared/screens";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "./audit-outbox.ts";
import {
  appOrigins,
  appVersions,
  blueprints,
  screenArtifacts,
  screenBuilds,
} from "./db/core/schema.ts";
import { advanceGeneration } from "./screen-trust.ts";
import { versionScreens } from "./screens.ts";

// What each screen of a version builds to with this release's kit, kept
// in D1 (`screen_builds`) so what waits for an admin is a query
// (screen-trust-rpc.ts): recorded where a version's screens are built
// anyway, never on a page's navigation. A version committed or made
// current records all of its screens; a screen opened or reviewed records
// what it built. A version made current before a release, and not opened
// or reviewed since, has no rows for the new kit until it is.
//
// Where a build is recorded, core has just built it from the version's
// own files: so this is where the release approves a copy's build of a
// built-in's exact code (app-blueprints.ts says why that is safe), before
// the gate reads the approval (screen-trust.ts).

/** One screen's build, as recorded. */
export interface RecordedBuild {
  screen: string;
  artifact: string;
}

/**
 * Who decided a build the release vouches for (`decided_by`): Grasp, which
 * reviewed the built-in blueprint's code with the platform. No person's
 * ID, which are random.
 */
export const releaseDecider = "grasp";

/**
 * Holds, as the statement runs, while version `version` of `app` is
 * exactly the code of the built-in blueprint it was created from, as the
 * release installed it, and this release's compiler and kit are the ones
 * the release vouches for it with (app-blueprints.ts): its origin is
 * core's record (`app_origins`), never the label `apps.blueprint`. And
 * never for a screen of the App an admin took a build of back: every
 * version builds that screen anew (its references name the version), so
 * vouching again would undo their decision with a commit of anything.
 * From then on its builds wait for an admin.
 */
const vouchedSql = (app: AppId, version: number, screen: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${appOrigins}
    JOIN ${blueprints} ON ${blueprints.id} = ${appOrigins.blueprintId}
    JOIN ${appVersions} ON ${appVersions.appId} = ${appOrigins.appId}
    WHERE ${appOrigins.appId} = ${app}
      AND ${appVersions.version} = ${version}
      AND ${blueprints.appId} IS NULL
      AND ${blueprints.attestedCode} = ${appVersions.code}
      AND ${blueprints.attestedRelease} = ${compilerVersion})
    AND NOT EXISTS (SELECT 1 FROM ${screenArtifacts}
      WHERE ${screenArtifacts.appId} = ${app}
        AND ${screenArtifacts.screen} = ${screen}
        AND ${screenArtifacts.status} = 'revoked')`;

/**
 * Records what screens of `app`'s `version` build to with this release.
 * A build of code the release vouches for (`vouchedSql`) is approved by
 * the release in the same batch, audited (`app.artifact.attested`), and
 * the App's policy generation moves on, as with an admin's approval
 * (screen-trust-rpc.ts). Never over a decision: a build an admin decided
 * on, approved or taken back, stays as they left it.
 */
export const recordBuilds = async (
  env: Env,
  app: AppId,
  version: number,
  built: RecordedBuild[]
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  const recorded = built.map(({ screen, artifact }) => {
    const event = createAuditEvent(
      {
        actor: { type: "system" },
        action: "app.artifact.attested",
        target: { type: "app", id: app },
        detail: { artifact, version, screen, release: compilerVersion },
      },
      "core"
    );
    return {
      event,
      statements: [
        db
          .insert(screenBuilds)
          .values({
            appId: app,
            version,
            release: compilerVersion,
            screen,
            artifact,
          })
          .onConflictDoNothing(),
        db
          .insert(screenArtifacts)
          // The table's columns, in its order.
          .select(
            sql`SELECT ${app}, ${artifact}, ${version}, ${screen}, 'approved', ${releaseDecider}, ${now} WHERE ${vouchedSql(app, version, screen)}`
          )
          .onConflictDoNothing(),
        outboxedEventWhere(db, event, sql`changes() > 0`),
      ],
    };
  });
  const [first, ...rest] = recorded.flatMap(({ statements }) => statements);
  if (first === undefined) {
    return;
  }
  const anyAttested = sql.join(
    recorded.map(({ event }) => storedEvent(event.id)),
    sql` OR `
  );
  await auditedBatch(env, db, [
    first,
    ...rest,
    advanceGeneration(db, app, sql`(${anyAttested})`),
  ]);
};

/**
 * Builds every screen of `app`'s `version` from `files` and records what
 * each builds to. Never throws: a version whose screens don't build has
 * nothing to approve, and one that can't be recorded now is when it is
 * next opened or reviewed.
 *
 * Screens that import the App's references (`#grasp`) build with them
 * only given `withReferences`, as a version made current is recorded:
 * its release is sealed by then, so the references are read back from it
 * (screen-references.ts), the very bytes opening the screen builds, and
 * the version waits on an admin before anyone opens it. A save records
 * without them, and those screens fail to build there: generating them
 * for a version not sealed yet inspects the App's code, which the save's
 * own build did once already (save-builds.ts).
 *
 * What it records is what each screen builds to (`screen_builds`), for
 * what waits on an admin. Nothing reads that to decide what a screen
 * gets: that is the approvals', an admin's, or the release's for a
 * built-in's exact code (`recordBuilds`).
 */
export const recordVersionBuilds = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>,
  {
    withReferences,
  }: {
    /** `files` with the references their screens import, if they get them. */
    withReferences?: (
      files: Record<string, string>
    ) => Promise<Record<string, string>>;
  } = {}
): Promise<void> => {
  const screens = Object.keys(files).flatMap((path) => {
    const name = screenPath.exec(path)?.groups?.name;
    return name === undefined ? [] : [name];
  });
  try {
    const built =
      withReferences === undefined ? files : await withReferences(files);
    const codeOf = await versionScreens(env, built, version, app);
    const recorded = await Promise.all(
      screens.map(async (name) => await codeOf(name))
    );
    await recordBuilds(env, app, version, recorded);
  } catch (error) {
    if (!isExpectedError(error)) {
      log.warn("screen.builds_not_recorded", {
        appId: app,
        version,
        ...errorFields(error),
      });
    }
  }
};

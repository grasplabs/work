import { compilerVersion } from "@grasp-os/compiler";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { screenPath } from "@grasp-os/shared/screens";
import { drizzle } from "drizzle-orm/d1";

import { screenBuilds } from "./db/core/schema.ts";
import { versionScreens } from "./screens.ts";

// What each screen of a version builds to with this release's kit, kept
// in D1 (`screen_builds`) so what waits for an admin is a query
// (screen-trust-rpc.ts): recorded where a version's screens are built
// anyway, never on a page's navigation. A version committed or made
// current records all of its screens; a screen opened or reviewed records
// what it built. A version made current before a release, and not opened
// or reviewed since, has no rows for the new kit until it is.

/** One screen's build, as recorded. */
export interface RecordedBuild {
  screen: string;
  artifact: string;
}

/** Records what screens of `app`'s `version` build to with this release. */
export const recordBuilds = async (
  env: Env,
  app: AppId,
  version: number,
  built: RecordedBuild[]
): Promise<void> => {
  const db = drizzle(env.DB);
  const [first, ...rest] = built.map(({ screen, artifact }) =>
    db
      .insert(screenBuilds)
      .values({
        appId: app,
        version,
        release: compilerVersion,
        screen,
        artifact,
      })
      .onConflictDoNothing()
  );
  if (first === undefined) {
    return;
  }
  await db.batch([first, ...rest]);
};

/**
 * Builds every screen of `app`'s `version` from `files` and records what
 * each builds to. Never throws: a version whose screens don't build has
 * nothing to approve, and one that can't be recorded now is when it is
 * next opened or reviewed. Screens that import the App's references
 * (`#grasp`) build without them here, and fail: generating them inspects
 * the App's code, which the save's own build did once already
 * (save-builds.ts). They are recorded once the version is reviewed or
 * opened.
 */
export const recordVersionBuilds = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>
): Promise<void> => {
  const screens = Object.keys(files).flatMap((path) => {
    const name = screenPath.exec(path)?.groups?.name;
    return name === undefined ? [] : [name];
  });
  try {
    const codeOf = await versionScreens(env, files, version, app);
    const built = await Promise.all(
      screens.map(async (name) => await codeOf(name))
    );
    await recordBuilds(env, app, version, built);
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

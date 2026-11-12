import { appIdSchema } from "@grasp-os/shared/ids";
import type {
  GrantReview,
  Permission,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { publishVersion } from "../src/app-publish.ts";
import { commitFiles, latestVersion } from "../src/apps.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { commitApp, definitionInput, sourceParts } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import type { Idp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

/**
 * `commitFiles` of a test's `source`: its files, with its definition when
 * it is a test's App, as `commitApp` commits them over RPC.
 */
export const commitDefined = async (
  on: Env,
  by: Parameters<typeof commitFiles>[1],
  app: string,
  source: TestSource,
  message: string
): ReturnType<typeof commitFiles> => {
  const { files, definition } = sourceParts(source);
  return await commitFiles(
    on,
    by,
    app,
    files,
    message,
    definition === undefined ? undefined : definitionInput(definition)
  );
};

/**
 * What `run` returns, run with core's clock `sessionRecheckMs` on: past
 * the time the connection's last reading of the session, and with it the
 * last answer to whether someone may still use an App, holds, so the next
 * push to their page checks again. Waiting that out for real
 * took five seconds a test, and raced a loaded runner. Tests wait at most
 * 3 s for the push that is refused, so only the moved clock can get there.
 */
export const pastAccessRecheck = async <T>(
  run: () => Promise<T>
): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + sessionRecheckMs });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** Someone signed in, with their API (`signedInApi`). */
type Builder = Pick<Awaited<ReturnType<typeof signedInApi>>, "api">;

/**
 * Classifies the App's data as ordinary, as an admin does
 * (`DataPolicyApi.classify`): code core didn't serve, a call with no
 * lease, then gets it too. For tests that call an App's functions without
 * a page's lease, which aren't about that (page-delivery.test.ts is).
 */
export const ordinaryData = async (app: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO screen_policies (app_id, output, generation) VALUES (?, 'ordinary', 1)
     ON CONFLICT (app_id) DO UPDATE SET output = 'ordinary', generation = generation + 1`
  )
    .bind(app)
    .run();
};

/**
 * Makes the App open to the people it is shared with, as its first
 * publish does: its latest version, an empty first one for an App with
 * none, published by its owner (app-publish.ts, `publishVersion`). For
 * tests of what those people do, which aren't about publishing
 * (draft-publish.test.ts and app-publish.test.ts are).
 */
export const published = async (app: string): Promise<void> => {
  const owner = await env.DB.prepare(
    `SELECT users.id AS userId, users.name AS name, users.email AS email, members.role AS role
     FROM apps JOIN users ON users.id = apps.owner_id
       JOIN members ON members.user_id = users.id
     WHERE apps.id = ?`
  )
    .bind(app)
    .first<Pick<Identity, "userId" | "name" | "email" | "role">>();
  if (owner === null) {
    throw new Error(`No App ${app}`);
  }
  const by: Identity = {
    ...owner,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const latest = await latestVersion(env, appIdSchema.parse(app));
  if (latest !== null) {
    await publishVersion(env, by, app, latest);
    return;
  }
  const first = await commitFiles(
    env,
    by,
    app,
    { "README.md": "An App.\n" },
    "First"
  );
  await publishVersion(env, by, app, first.version);
};

/**
 * Makes version 1 of App `app`, a stand-in its test wrote straight to the
 * database (no tree a publish could seal), live, as a publish leaves it:
 * for tests of what runs on it, which bind what it uses first, as a
 * binding of a live App reads the declarations of its release.
 */
export const standInLive = async (app: string): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE app_versions SET status = 'published' WHERE app_id = ? AND version = 1"
    ).bind(app),
    env.DB.prepare("UPDATE apps SET current_version = 1 WHERE id = ?").bind(
      app
    ),
  ]);
};

/**
 * Commits `files` as the App's next version and publishes it, with its
 * data classified as ordinary (`ordinaryData`), so a call without a
 * page's lease reaches it too.
 */
export const release = async (
  builder: Builder,
  app: string,
  files: TestSource
): Promise<number> => {
  const { version } = await commitApp(
    builder.api.apps.files,
    app,
    files,
    "Release"
  );
  await builder.api.apps.versions.publish(app, version);
  await ordinaryData(app);
  return version;
};

/** Outlook, as a connection the App may be given. */
export const outlook = (
  app: string,
  binding = "OUTLOOK"
): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list"],
  binding,
});

/** An admin's API (`signedInApi`). */
type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

/**
 * What an admin reviews as they grant the permission `id`: the version of
 * its App current now, or none for an agent's, or an App with none
 * current (`PermissionsApi.grant`).
 */
export const reviewedOf = async (
  api: Api,
  id: string
): Promise<GrantReview> => {
  const listed = await api.permissions.list();
  const found = listed.find((permission) => permission.id === id);
  // The App asking, or the App whose one function a workflow asks for.
  let reviewed: string | undefined;
  if (found?.subject.type === "app") {
    reviewed = found.subject.appId;
  } else if (
    found?.object.type === "app" &&
    found.object.function !== undefined
  ) {
    reviewed = found.object.appId;
  }
  if (reviewed === undefined) {
    return { version: null };
  }
  const apps = await api.apps.list();
  const app = apps.find(({ id: appId }) => appId === reviewed);
  return { version: app?.currentVersion ?? null };
};

/** Grants the permission `id` as `api`'s admin, having reviewed it now. */
export const grantReviewed = async (
  api: Api,
  id: string
): Promise<Permission> =>
  await api.permissions.grant(id, await reviewedOf(api, id));

/**
 * Asks for `request` as `requester`, who may be a builder, and has an
 * admin, signed in for it, grant it. Returns its ID.
 */
export const requestGranted = async (
  idp: Idp,
  requester: Builder,
  request: PermissionRequest
): Promise<string> => {
  const { id } = await requester.api.permissions.request(request);
  const admin = await signedInApi(idp, "admin");
  try {
    await grantReviewed(admin.api, id);
  } finally {
    admin.core[Symbol.dispose]();
  }
  return id;
};

/**
 * Core's database, with `first` run just before each of the first `times`
 * batches after a statement that `writes` matches was prepared lands:
 * another writer getting there first.
 */
export const racingDb = (
  first: () => Promise<unknown>,
  writes: RegExp,
  times = 1
): D1Database => {
  const real = env.DB;
  let writing = false;
  let raced = 0;
  return {
    prepare: (query) => {
      writing ||= writes.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (writing && raced < times) {
        raced += 1;
        writing = false;
        await first();
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/**
 * Core's database, but a batch holding a statement `writes` matches commits
 * and then fails, once, as a batch whose answer was lost does.
 */
export const lostAnswerDb = (writes: RegExp): D1Database => {
  const real = env.DB;
  let writing = false;
  let lost = false;
  return {
    prepare: (query) => {
      writing ||= writes.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const results = await real.batch<T>(statements);
      if (writing && !lost) {
        lost = true;
        throw new Error("D1 lost the batch's answer");
      }
      return results;
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/**
 * Core's database, but a batch holding a statement `writes` matches fails
 * every time without committing, as D1 refusing it does.
 */
export const failingDb = (writes: RegExp): D1Database => {
  const real = env.DB;
  let writing = false;
  return {
    prepare: (query) => {
      writing ||= writes.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (writing) {
        writing = false;
        throw new Error("D1 refused the batch");
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/**
 * Marks `version` of `app` published (src/app-publish.ts) with the release
 * sealed for it, as making it current requires: for tests that make a version current by hand, as
 * another writer would, to race or bypass the real path.
 */
export const markPublished = async (
  app: string,
  version: number
): Promise<void> => {
  await env.DB.prepare(
    `UPDATE app_versions SET status = 'published', published_manifest_hash =
      (SELECT manifest_hash FROM sdk_release_manifests WHERE app_id = ?1 AND version = ?2)
    WHERE app_id = ?1 AND version = ?2`
  )
    .bind(app, version)
    .run();
};

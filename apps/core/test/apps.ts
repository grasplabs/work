import type {
  GrantReview,
  Permission,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { commitFiles } from "../src/apps.ts";
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
 * Marks the App published, as its builders would publish it
 * (app-status.ts), whether or not a version of it is current: for tests
 * of what people it is shared with do, which aren't about its status
 * (app-status.test.ts is).
 */
export const published = async (app: string): Promise<void> => {
  await env.DB.prepare("UPDATE apps SET status = 'published' WHERE id = ?")
    .bind(app)
    .run();
};

/**
 * Commits `files` as the App's next version, makes it current and
 * publishes the App, with its data classified as ordinary
 * (`ordinaryData`), so a call without a page's lease reaches it too.
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
  await builder.api.apps.versions.setCurrent(app, version);
  // Published, for the people it is shared with: a draft is its builders'.
  // Once is enough, and Grasp staff, who release too, never publish.
  const { status } = await builder.api.apps.get(app);
  if (status !== "published") {
    await builder.api.apps.publish(app);
  }
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

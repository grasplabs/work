import { emptyDefinition, readDefinition } from "@grasp-os/runtime/definition";
import type { AppVersion } from "@grasp-os/shared/apps";
import type { LiveVersion, Version } from "@grasp-os/shared/drafts";
import { appIdSchema } from "@grasp-os/shared/ids";
import type {
  GrantReview,
  Permission,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { defineDraft, writeAppDraft } from "../src/app-review.ts";
import {
  appKind,
  applyChanges,
  commitDraft,
  draftDefinition,
  editableApp,
  latestVersion,
} from "../src/apps.ts";
import { draftOf, filesOf } from "../src/drafts.ts";
import { publish, rollback } from "../src/publish.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { definitionInput, sourceParts } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import type { Idp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

/**
 * A test's publish of `source` by `by`, in core, as `publishApp` does it
 * over RPC: its definition, when it is a test's App, written whole into
 * App `app`'s draft (`defineDraft`), then its files over the revision
 * read (`writeAppDraft`), then the draft published (publish.ts). Answers
 * the version made live.
 */
export const publishDefined = async (
  on: Env,
  by: Identity,
  app: string,
  source: TestSource
): Promise<LiveVersion> => {
  let { revision } = await draftOf(on, appKind, app);
  const { files, definition } = sourceParts(source);
  if (definition !== undefined) {
    const defined = await defineDraft(on, by, app, {
      op: "setDefinition",
      definition: definitionInput(definition),
    });
    if (!defined.ok) {
      throw new Error(defined.problem);
    }
    revision += 1;
  }
  if (Object.keys(files).length > 0) {
    await writeAppDraft(on, by, app, revision, { ...files });
    revision += 1;
  }
  return await publish(on, appKind, by, app, revision);
};

/**
 * Commits `source` as App `app`'s next version for `by`, in core, as
 * publishing commits a draft (`commitDraft`): its files, with its
 * definition when it is a test's App (else the latest version's), over
 * the App's latest version. Leaves the draft alone, and is neither
 * checked nor built nor live: for tests whose Apps aren't about
 * publishing, which make the version live as a roll back does
 * (`release`), or run it as they need. Answers the version.
 */
export const commitDefined = async (
  on: Env,
  by: Identity,
  app: string,
  source: TestSource
): Promise<{ version: number }> => {
  const { id, name } = await editableApp(on, by, app);
  const parent = await latestVersion(on, id);
  const { files: changes, definition } = sourceParts(source);
  const latest = await draftDefinition(on, id, {
    base: parent,
    definition: null,
  });
  const defined =
    definition === undefined
      ? (latest?.definition ?? emptyDefinition(name))
      : readDefinition(definitionInput(definition));
  const files = await filesOf(on, appKind, id, { base: parent, changes: {} });
  applyChanges(files, changes, defined);
  const { version } = await commitDraft(on, by, id, {
    parent,
    version: (parent ?? 0) + 1,
    files,
    definition: defined,
  });
  return { version };
};

/** `commitDefined`, for the person signed in to `api`. */
export const commitApp = async (
  api: Pick<Builder["api"], "whoami">,
  app: string,
  source: TestSource
): Promise<{ version: number }> =>
  await commitDefined(env, await api.whoami(), app, source);

/**
 * Binds workflow `workflowId` to App `app` under `alias` for `by`, written
 * straight to the database as an App version binding it leaves it, at the
 * workflow's live version: for tests whose App is a stand-in written to
 * the database too, with no release to publish. Answers the binding's ID.
 */
export const standInBinding = async (
  app: string,
  alias: string,
  workflowId: string,
  by: Pick<Identity, "userId">
): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO app_workflow_bindings (id, app_id, alias, workflow_resource_id, workflow_resource_version, status, bound_by, bound_at)
     SELECT ?, ?, ?, id, current_version, 'active', ?, ? FROM workflow_resources WHERE id = ?`
  )
    .bind(id, app, alias, by.userId, Date.now(), workflowId)
    .run();
  return id;
};

/** The ID of App `app`'s active binding of `alias`, which its live version made. */
export const activeBinding = async (
  app: string,
  alias: string
): Promise<string> => {
  const row = await env.DB.prepare(
    "SELECT id FROM app_workflow_bindings WHERE app_id = ? AND alias = ? AND status = 'active'"
  )
    .bind(app, alias)
    .first<{ id: string }>();
  if (row === null) {
    throw new Error(`${app} binds nothing as ${alias}`);
  }
  return row.id;
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

/** The App versions among `versions`, as `versions.list` answers every kind's. */
export const appVersionsOf = (versions: readonly Version[]): AppVersion[] =>
  versions.flatMap((version) => ("app" in version ? [version] : []));

/** `version` as an App's version, which `versions.get` of an App answers. */
export const appVersionOf = (version: Version): AppVersion => {
  if (!("app" in version)) {
    throw new Error("Not an App's version");
  }
  return version;
};

/**
 * Makes the App open to the people it is shared with, as its first
 * publish does: its latest version, an empty first one for an App with
 * none, made live by its owner (publish.ts, `rollback`). For
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
    await rollback(env, appKind, by, app, latest);
    return;
  }
  const { version } = await commitDefined(env, by, app, {
    "README.md": "An App.\n",
  });
  await rollback(env, appKind, by, app, version);
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
 * Commits `files` as the App's next version (`commitApp`) and makes it
 * live, with its data classified as ordinary (`ordinaryData`), so a call
 * without a page's lease reaches it too.
 */
export const release = async (
  builder: Builder,
  app: string,
  files: TestSource
): Promise<number> => {
  const { version } = await commitApp(builder.api, app, files);
  await builder.api.versions.rollback({ kind: "app", id: app }, version);
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

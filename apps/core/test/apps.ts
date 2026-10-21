import type {
  GrantReview,
  Permission,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { sessionRecheckMs } from "../src/session-check.ts";
import type { Idp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

/**
 * What `run` returns, run with core's clock `sessionRecheckMs` on: past
 * the time the connection's last reading of the session, and with it the
 * last answer to whether someone may still use an App, holds, so the next
 * push to their screen checks again. Waiting that out for real
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
 * (`ScreenTrustApi.classify`): its screens then get it whoever approved
 * their code, or nobody. For tests of what a screen does with its App,
 * which aren't about who approved its code (screen-trust.test.ts is).
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
 * Commits `files` as the App's next version and makes it current, with
 * the App's data classified as ordinary (`ordinaryData`).
 */
export const release = async (
  builder: Builder,
  app: string,
  files: Record<string, string | null>
): Promise<number> => {
  const { version } = await builder.api.apps.files.commit(
    app,
    files,
    "Release"
  );
  await builder.api.apps.versions.setCurrent(app, version);
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
  const subject = listed.find((permission) => permission.id === id)?.subject;
  if (subject?.type !== "app") {
    return { version: null };
  }
  const apps = await api.apps.list();
  const app = apps.find(({ id: appId }) => appId === subject.appId);
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

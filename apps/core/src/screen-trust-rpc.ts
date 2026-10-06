import { buildFiles, compilerVersion } from "@grasp-os/compiler";
import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditDetailValue, AuditEvent } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  artifactSchema,
  generationSchema,
  outputClassSchema,
  screenApprovalSchema,
} from "@grasp-os/shared/screen-trust";
import type {
  DecidedBuild,
  OutputClass,
  ReviewedScreen,
  ScreenApproval,
  ScreensWaiting,
  ScreenTrustApi,
  ScreenTrustReview,
} from "@grasp-os/shared/screen-trust";
import { screenErrors } from "@grasp-os/shared/screens";
import { RpcTarget } from "capnweb";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor, screensIn, versionFiles } from "./apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "./audit-outbox.ts";
import {
  apps,
  screenArtifacts,
  screenBuilds,
  screenPolicies,
} from "./db/core/schema.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdminSql,
} from "./permissions.ts";
import { recordBuilds } from "./screen-builds.ts";
import {
  advanceGeneration,
  generationSql,
  standingOf,
} from "./screen-trust.ts";
import { versionScreens } from "./screens.ts";
import type { VersionScreens } from "./screens.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The decisions the gate reads (screen-trust.ts): an admin approving the
// exact builds of a version's screens, taking one back, and saying what an
// App's data is to its screens. Only one of the organization's own admins
// decides, from their own session: this is reached over a person's `/rpc`
// only, so no agent, workflow or App gets here, Grasp staff are refused,
// and that the admin still is one is part of each write. This approval is
// its own thing: not a version made current, not a permission granted,
// not the packages an App may use, and no test or scan stands in for it.
//
// What is approved is what core builds, not what anyone names. An approval
// names the hashes its admin was shown; core builds the version again and
// takes the approval only if it comes to exactly those, under the policy
// generation they were shown. So a version edited, a package changed or a
// new kit since the review is refused, not approved unseen.

/** An App's audit entry here: identifiers only. */
const eventFor = (
  by: Identity,
  action:
    | "app.artifact.approved"
    | "app.artifact.revoked"
    | "app.output.classified",
  app: AppId,
  detail: Record<string, AuditDetailValue>
): AuditEvent =>
  createAuditEvent(
    { actor: actorOf(by), action, target: { type: "app", id: app }, detail },
    "core"
  );

/** Each screen of the App's `version`, with the hash core builds it to now. */
const builtScreens = async (
  env: Env,
  app: AppId,
  version: number
): Promise<{ screen: string; artifact: string }[]> => {
  const files = await versionFiles(env, app, version);
  const codeOf = await versionScreens(env, files, version);
  const built = await Promise.all(
    screensIn(new Map(Object.entries(files))).map(async (name) => {
      const { screen, artifact } = await codeOf(name);
      return { screen, artifact };
    })
  );
  await recordBuilds(env, app, version, built);
  return built;
};

/** The version to review: the one named, or the App's current one. */
const versionOf = (app: App, version: unknown): number => {
  if (version !== undefined) {
    return appErrors.parse("app.version_not_found", appVersionSchema, version);
  }
  if (app.currentVersion === null) {
    throw appErrors.create("app.not_running");
  }
  return app.currentVersion;
};

/**
 * Each screen of the App's `version`, with the hash core builds it to now,
 * or null for one that doesn't build now: the version built once, within
 * the build wait, so a build that fails or stalls leaves every screen
 * without a hash and the review as it is, and each screen's code taken
 * from it on its own, so one that fails leaves the others.
 */
const reviewedBuilds = async (
  env: Env,
  app: AppId,
  version: number
): Promise<{ screen: string; artifact: string | null }[]> => {
  const files = await versionFiles(env, app, version);
  const noted = (error: unknown): null => {
    if (!isExpectedError(error)) {
      log.warn("screen.review_build_failed", {
        appId: app,
        version,
        ...errorFields(error),
      });
    }
    return null;
  };
  let codeOf: VersionScreens | null;
  try {
    codeOf = await versionScreens(env, files, version);
  } catch (error) {
    codeOf = noted(error);
  }
  const built = await Promise.all(
    screensIn(new Map(Object.entries(files))).map(async (name) => {
      if (codeOf === null) {
        return { screen: name, artifact: null };
      }
      try {
        const { artifact } = await codeOf(name);
        return { screen: name, artifact };
      } catch (error) {
        return { screen: name, artifact: noted(error) };
      }
    })
  );
  await recordBuilds(
    env,
    app,
    version,
    built.flatMap(({ screen, artifact }) =>
      artifact === null ? [] : [{ screen, artifact }]
    )
  );
  return built;
};

const reviewOf = async (
  env: Env,
  app: App,
  version: number
): Promise<ScreenTrustReview> => {
  const built = await reviewedBuilds(env, app.id, version);
  const [{ output, generation }, rows] = await Promise.all([
    standingOf(env, app.id),
    // Every decision on the App's builds: the current version's and the
    // ones before, any of which may still be approved.
    drizzle(env.DB)
      .select()
      .from(screenArtifacts)
      .where(eq(screenArtifacts.appId, app.id))
      .orderBy(desc(screenArtifacts.decidedAt), screenArtifacts.artifact),
  ]);
  const held = new Map(rows.map((row) => [row.artifact, row]));
  return {
    app: app.id,
    name: app.name,
    version,
    output,
    generation,
    screens: built.map(({ screen, artifact }): ReviewedScreen => {
      const row = artifact === null ? undefined : held.get(artifact);
      return {
        screen,
        artifact,
        trust: row?.status ?? "unreviewed",
        decidedBy: row?.decidedBy ?? null,
        decidedAt: row?.decidedAt.toISOString() ?? null,
      };
    }),
    decided: rows.map((row): DecidedBuild => ({
      artifact: row.artifact,
      version: row.version,
      screen: row.screen,
      trust: row.status,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt.toISOString(),
    })),
  };
};

/**
 * The screens of the App's `version` (its current one when none is
 * named) as core builds them now, for its builders: who can read the
 * source the hashes stand for.
 */
export const reviewScreens = async (
  env: Env,
  by: Identity,
  app: unknown,
  version?: unknown
): Promise<ScreenTrustReview> => {
  const found = await appFor(env, by, app, "builder");
  return await reviewOf(env, found, versionOf(found, version));
};

/**
 * The source the App's screens at `version` are built from, by path, for
 * its builders: what the hashes of that version's builds stand for,
 * besides the release's kit.
 */
export const screenSource = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<Record<string, string>> => {
  const found = await appFor(env, by, app, "builder");
  const number = appErrors.parse(
    "app.version_not_found",
    appVersionSchema,
    version
  );
  return buildFiles(await versionFiles(env, found.id, number));
};

/** The condition every decision's write carries: still an admin, and nothing changed since the review. */
const reviewedUnder = (by: Identity, app: AppId, generation: number): SQL =>
  sql`${stillAdminSql(by)} AND ${generationSql(app)} = ${generation}`;

/**
 * Approves the builds an admin reviewed, all in one batch: each lands
 * only while `by` is still an admin and the App's policy is at the
 * generation they reviewed, with its own audit event, and the generation
 * moves on if any did. A build already approved changes and records
 * nothing.
 */
export const approveScreens = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<ScreenTrustReview> => {
  requireMemberAdmin(by);
  const found = await appFor(env, by, app, "builder");
  const reviewed = screenErrors.parse(
    "screen.invalid",
    screenApprovalSchema,
    input
  );
  const built = await builtScreens(env, found.id, reviewed.version);
  const named = new Set(reviewed.artifacts);
  if (
    named.size !== built.length ||
    built.some(({ artifact }) => !named.has(artifact))
  ) {
    throw screenErrors.create("screen.review_outdated");
  }
  const db = drizzle(env.DB);
  const now = Date.now();
  const condition = reviewedUnder(by, found.id, reviewed.generation);
  const decisions = built.map(({ screen, artifact }) => {
    const event = eventFor(by, "app.artifact.approved", found.id, {
      artifact,
      version: reviewed.version,
      screen,
      generation: reviewed.generation,
    });
    return {
      event,
      statements: [
        db
          .insert(screenArtifacts)
          // The table's columns, in its order.
          .select(
            sql`SELECT ${found.id}, ${artifact}, ${reviewed.version}, ${screen}, 'approved', ${by.userId}, ${now} WHERE ${condition}`
          )
          .onConflictDoUpdate({
            target: [screenArtifacts.appId, screenArtifacts.artifact],
            set: {
              status: "approved",
              decidedBy: sql`excluded.decided_by`,
              decidedAt: sql`excluded.decided_at`,
            },
            setWhere: sql`${screenArtifacts.status} <> 'approved'`,
          }),
        outboxedEventWhere(db, event, sql`changes() > 0`),
      ],
    };
  });
  const anyStored = sql.join(
    decisions.map(({ event }) => storedEvent(event.id)),
    sql` OR `
  );
  const [first, ...rest] = decisions.flatMap(({ statements }) => statements);
  if (first === undefined) {
    throw screenErrors.create("screen.review_outdated");
  }
  await auditedBatch(env, db, [
    first,
    ...rest,
    advanceGeneration(db, found.id, sql`(${anyStored})`),
  ]);
  const after = await reviewOf(env, found, reviewed.version);
  if (after.screens.some(({ trust }) => trust !== "approved")) {
    // Nothing landed: they are no longer an admin, or the App's approvals
    // or classification changed since they reviewed it.
    await requireStillAdmin(env, by);
    throw screenErrors.create("screen.review_outdated");
  }
  return after;
};

/**
 * Takes back the approval of one build of the App's screens: one update
 * that lands only while it is approved and `by` is still an admin, in the
 * batch that records it and moves the App's policy generation on. Once
 * that batch has committed, every check of the gate reads it: the next
 * call, answer or push for that build is refused. Taking back what is
 * already taken back changes and records nothing.
 */
export const revokeScreen = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const found = await appFor(env, by, app, "builder");
  const artifact = screenErrors.parse("screen.invalid", artifactSchema, input);
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(screenArtifacts)
    .where(
      and(
        eq(screenArtifacts.appId, found.id),
        eq(screenArtifacts.artifact, artifact)
      )
    )
    .get();
  if (row === undefined) {
    throw screenErrors.create("screen.not_approved");
  }
  const event = eventFor(by, "app.artifact.revoked", found.id, {
    artifact,
    version: row.version,
    screen: row.screen,
  });
  const [[revoked]] = await auditedBatch(env, db, [
    db
      .update(screenArtifacts)
      .set({ status: "revoked", decidedBy: by.userId, decidedAt: new Date() })
      .where(
        and(
          eq(screenArtifacts.appId, found.id),
          eq(screenArtifacts.artifact, artifact),
          eq(screenArtifacts.status, "approved"),
          stillAdminSql(by)
        )
      )
      .returning(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    advanceGeneration(db, found.id, storedEvent(event.id)),
  ]);
  if (!revoked) {
    await requireStillAdmin(env, by);
  }
};

/**
 * Says what the App's data is to its screens: `ordinary` is an admin
 * accepting that it goes to code nobody approved, `sensitive` takes that
 * back. One write, only while `by` is still an admin, that moves the
 * App's policy generation on and is recorded on its own
 * (`app.output.classified`). Saying what already holds changes and
 * records nothing.
 */
export const classifyOutput = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown,
  reviewed: unknown
): Promise<OutputClass> => {
  requireMemberAdmin(by);
  const found = await appFor(env, by, app, "builder");
  const output = screenErrors.parse("screen.invalid", outputClassSchema, input);
  const generation = screenErrors.parse(
    "screen.invalid",
    generationSchema,
    reviewed
  );
  const db = drizzle(env.DB);
  const { output: previous } = await standingOf(env, found.id);
  if (previous === output) {
    return output;
  }
  const event = eventFor(by, "app.output.classified", found.id, {
    output,
    previous,
  });
  await auditedBatch(env, db, [
    db
      .insert(screenPolicies)
      // The table's columns, in its order.
      .select(
        sql`SELECT ${found.id}, ${output}, 1 WHERE ${reviewedUnder(by, found.id, generation)}`
      )
      .onConflictDoUpdate({
        target: screenPolicies.appId,
        set: {
          output: sql`excluded.output`,
          generation: sql`${screenPolicies.generation} + 1`,
        },
        setWhere: sql`${screenPolicies.output} <> excluded.output`,
      }),
    outboxedEventWhere(db, event, sql`changes() > 0`),
  ]);
  const { output: now } = await standingOf(env, found.id);
  if (now !== output) {
    // Nothing landed: they are no longer an admin, or the App's policy
    // moved on since they reviewed it (an approval, a grant).
    await requireStillAdmin(env, by);
    throw screenErrors.create("screen.review_outdated");
  }
  return now;
};

/**
 * The Apps whose data is sensitive and whose current version has screens
 * that build, with this release's kit, to code no admin decided on, by
 * name: what waits for an admin. One query over what was recorded where
 * builds happen (screen-builds.ts), never a build. A version waits from
 * the moment it is current; a build an admin took back was decided, and
 * doesn't ask again. None for anyone but an admin, Grasp staff included.
 */
export const screensWaiting = async (
  env: Env,
  by: Identity
): Promise<ScreensWaiting[]> => {
  if (!isAdmin(by.role) || by.staff) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .selectDistinct({
      app: apps.id,
      name: apps.name,
      version: screenBuilds.version,
      screen: screenBuilds.screen,
    })
    .from(apps)
    .innerJoin(
      screenBuilds,
      and(
        eq(screenBuilds.appId, apps.id),
        eq(screenBuilds.version, apps.currentVersion),
        eq(screenBuilds.release, compilerVersion)
      )
    )
    .where(
      and(
        sql`NOT EXISTS (
          SELECT 1 FROM ${screenPolicies}
          WHERE ${screenPolicies.appId} = ${apps.id}
            AND ${screenPolicies.output} = 'ordinary'
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${screenArtifacts}
          WHERE ${screenArtifacts.appId} = ${apps.id}
            AND ${screenArtifacts.artifact} = ${screenBuilds.artifact}
        )`
      )
    )
    .orderBy(apps.name, apps.id, screenBuilds.screen);
  const waiting = new Map<string, ScreensWaiting>();
  for (const { app, name, version, screen } of rows) {
    const listed = waiting.get(app) ?? {
      app: appIdSchema.parse(app),
      name,
      version,
      screens: [],
    };
    listed.screens.push(screen);
    waiting.set(app, listed);
  }
  return [...waiting.values()];
};

/**
 * A signed-in person's `screenTrust`. Every call checks the session first
 * and hands the identity that check returned on; each function checks who
 * the person is now.
 */
export class ScreenTrustRpc extends RpcTarget implements ScreenTrustApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async review(app: string, version?: number): Promise<ScreenTrustReview> {
    return await withPerson(
      this.#check,
      async (by) => await reviewScreens(this.#env, by, app, version)
    );
  }

  async approve(
    app: string,
    reviewed: ScreenApproval
  ): Promise<ScreenTrustReview> {
    return await withPerson(
      this.#check,
      async (by) => await approveScreens(this.#env, by, app, reviewed)
    );
  }

  async revoke(app: string, artifact: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await revokeScreen(this.#env, by, app, artifact);
    });
  }

  async classify(
    app: string,
    output: OutputClass,
    generation: number
  ): Promise<OutputClass> {
    return await withPerson(
      this.#check,
      async (by) => await classifyOutput(this.#env, by, app, output, generation)
    );
  }

  async source(app: string, version: number): Promise<Record<string, string>> {
    return await withPerson(
      this.#check,
      async (by) => await screenSource(this.#env, by, app, version)
    );
  }

  async waiting(): Promise<ScreensWaiting[]> {
    return await withPerson(
      this.#check,
      async (by) => await screensWaiting(this.#env, by)
    );
  }
}

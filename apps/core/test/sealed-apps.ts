import { declaredWorkflows, workflowQueries } from "@grasp-os/sdk/host";
import type { WorkflowQueryName } from "@grasp-os/sdk/host";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";

import { callAppFunction } from "../src/app-functions.ts";
import { sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles, createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appStoreFor } from "../src/data-stores.ts";
import {
  keptReleases,
  sealGraceMs,
  sweepReleases,
} from "../src/release-retention.ts";
import { artifactKey as keyOf } from "../src/sealed-artifacts.ts";
import { published } from "./apps.ts";

// Apps of spec 8's layout as the release tests build them: a builder's
// App committed with given files, its store, and its seal.

/** A person of the organization in `role`, as their session has them. */
export const person = async (role: Role): Promise<Acting & Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

export interface Fixture {
  readonly owner: Acting & Identity;
  readonly app: AppId;
  readonly store: StoreId;
}

/** A builder's App `name` with `files` as its first version, and its store. */
export const appWith = async (
  files: Record<string, string>,
  name = "Notes",
  /** Who creates it: a new builder unless given. */
  by?: Identity
): Promise<Fixture> => {
  const owner = by ?? (await person("builder"));
  const { id } = await createApp(env, owner, { name });
  // Published, for the people it is shared with: a draft is its builders'
  // alone (app-status.ts), and these tests aren't about its status.
  await published(id);
  await commitFiles(env, owner, id, files, "First version");
  return { owner, app: id, store: await appStoreFor(env, owner, id) };
};

/** Seals the fixture's `version`, on its App's store. */
export const seal = async (
  { owner, app }: Fixture,
  version = 1
): Promise<Release> => await sealRelease(env, { app, version, by: owner });

/** A public function of an App's release, as a page names it. */
export interface FunctionName {
  /** Its name, `<module>.<export>`, as its server modules lay it out. */
  readonly name: string;
  readonly kind: "query" | "mutation" | "action";
}

/**
 * What `by` gets calling `name` of App `app` with `input`, as a page
 * calls it (`callAppFunction`): by its name, answered by the release of
 * the App's current version.
 */
export const calledAs = async (
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: string,
  { name, kind }: FunctionName,
  input: unknown = {}
): Promise<OperationResult> => {
  const answered = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({ reference: { name, kind }, input })
  );
  return answered.result;
};

/** The error code `work` fails with. */
export const failure = async (
  work: () => Promise<unknown>
): Promise<string> => {
  try {
    await work();
  } catch (error) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    return typeof code === "string" ? code : String(error);
  }
  return "ok";
};

/** Where the artifact `sha256`'s bytes are kept: under its live generation. */
export const artifactKey = async (sha256: string): Promise<string> => {
  const row = await env.DB.prepare(
    "SELECT generation FROM sdk_artifacts WHERE sha256 = ?"
  )
    .bind(sha256)
    .first<{ generation: string }>();
  return keyOf(sha256, row?.generation ?? "none");
};

/**
 * Stores `body` as the artifact `sha256`, under its live generation or a
 * new one referenced by a seal of its own, whatever its bytes hash to: for
 * tests that forge or swap artifacts.
 */
export const putArtifact = async (
  sha256: string,
  body: string | Uint8Array
): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sdk_artifacts (sha256, generation, created_at) VALUES (?, lower(hex(randomblob(16))), ?) ON CONFLICT (sha256) DO NOTHING"
    ).bind(sha256, Date.now()),
    env.DB.prepare(
      "INSERT INTO sdk_artifact_refs (seal, sha256, created_at) VALUES (?, ?, ?)"
    ).bind(crypto.randomUUID(), sha256, Date.now()),
  ]);
  await env.FILES.put(await artifactKey(sha256), body);
};

/** The first version of the stand-in releases `newerReleases` writes. */
const newerFrom = 1_000_000;

/**
 * Writes `keptReleases` stand-in releases of App `app`, newer than any it
 * has, so retention keeps none of its own for being among its latest; and
 * a function that removes them again.
 */
export const newerReleases = async (
  app: AppId
): Promise<() => Promise<void>> => {
  await env.DB.batch(
    Array.from({ length: keptReleases }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO sdk_release_manifests (app_id, version, manifest_hash, manifest, sealed_at) VALUES (?, ?, 'stand-in', '{}', ?)"
      ).bind(app, newerFrom + index, Date.now())
    )
  );
  return async () => {
    await env.DB.prepare(
      "DELETE FROM sdk_release_manifests WHERE app_id = ? AND version >= ?"
    )
      .bind(app, newerFrom)
      .run();
  };
};

/**
 * Lets retention delete App `app`'s release `version`, kept by nothing
 * but being among its latest and its seal's grace: sweeps past the grace
 * with newer stand-in releases in place (`newerReleases`), as often as it
 * takes, since one sweep deletes a bounded batch of the releases due.
 */
export const sweptAway = async (app: AppId, version: number): Promise<void> => {
  const removeNewer = await newerReleases(app);
  try {
    for (let sweep = 0; sweep < 50; sweep += 1) {
      // One sweep after the other: each sees what the one before left.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await sweepReleases(env, new Date(Date.now() + sealGraceMs + 60_000));
      // oxlint-disable-next-line no-await-in-loop -- see above
      const kept = await env.DB.prepare(
        "SELECT 1 FROM sdk_release_manifests WHERE app_id = ? AND version = ?"
      )
        .bind(app, version)
        .first();
      if (kept === null) {
        return;
      }
    }
  } finally {
    await removeNewer();
  }
  throw new Error(`Retention kept version ${version} of App ${app}`);
};

/**
 * The reference to query `name` of the workflow the App declares as
 * `alias`, as `@server/_generated/api` generates it from `release`.
 */
export const queryReference = (
  release: Release,
  alias: string,
  name: WorkflowQueryName
) => {
  const bound = declaredWorkflows(release.app, release.workflows).find(
    (workflow) => workflow.alias === alias
  );
  const operation =
    bound === undefined ? undefined : workflowQueries(bound)[name];
  if (operation === undefined) {
    throw new Error(`No query ${name} of ${alias}`);
  }
  return { name: operation.path, kind: "query" as const };
};

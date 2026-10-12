import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";

import { sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles, createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { createStore, shareStore } from "../src/data-stores.ts";
import {
  releaseGraceMs,
  releaseRetentionMs,
  sweepReleases,
} from "../src/release-retention.ts";

// Apps of spec 8's layout as the release tests build them: a builder's
// App committed with given files, a store for it, and its seal.

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

/** A builder's App with `files` as its first version, and a store for it. */
export const appWith = async (
  files: Record<string, string>
): Promise<Fixture> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitFiles(env, owner, id, files, "First version");
  return { owner, app: id, store: await createStore(env, owner) };
};

/**
 * Shares `fixture`'s store with `other`'s owner, to manage: so `other`'s
 * owner may bind it to a release too.
 */
export const shareStoreWith = async (
  fixture: Fixture,
  other: Fixture
): Promise<void> => {
  await shareStore(env, fixture.owner, fixture.store, {
    type: "person",
    id: other.owner.userId,
  });
};

/** Seals the fixture's `version`, with its store. */
export const seal = async (
  { owner, app, store }: Fixture,
  version = 1
): Promise<Release> =>
  await sealRelease(env, { app, version, store, by: owner });

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

/** Where an artifact's bytes are kept. */
export const artifactKey = (sha256: string): string =>
  `release-artifacts/${sha256}`;

/**
 * Lets retention delete App `app`'s release `version`, kept by nothing
 * but its 90 days: sweeps past them and the grace, as often as it takes,
 * since one sweep deletes a bounded batch of the releases due.
 */
export const sweptAway = async (app: AppId, version: number): Promise<void> => {
  const now = Date.now();
  await sweepReleases(env, new Date(now + releaseRetentionMs + 60_000));
  for (let sweep = 0; sweep < 50; sweep += 1) {
    // One sweep after the other: each sees what the one before left.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const kept = await env.DB.prepare(
      "SELECT 1 FROM sdk_release_manifests WHERE app_id = ? AND version = ?"
    )
      .bind(app, version)
      .first();
    if (kept === null) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    await sweepReleases(
      env,
      new Date(now + releaseRetentionMs + releaseGraceMs + 120_000)
    );
  }
  throw new Error(`Retention kept version ${version} of App ${app}`);
};

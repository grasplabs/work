import { describe, expect, it } from "vite-plus/test";

import { canMove, installMismatch } from "../src/release-apply.ts";
import { MANIFEST_VERSION } from "../src/release.ts";
import type { ReleaseManifest, WorkerEntry } from "../src/release.ts";

// Whether a deployment may move between two releases (`canMove`), and
// whether what it answers is a release installed (`installMismatch`):
// pure, on manifests. Their callers, the admin's operation and promotion,
// are tried end to end in the admin's tests.

/** A Worker of a release, with its Durable Object migrations by tag. */
const worker = (name: string, tags: readonly string[]): WorkerEntry => ({
  name,
  mainModule: "index.js",
  modules: [],
  compatibilityFlags: [],
  bindings: [],
  d1Databases: [],
  durableObjectMigrations: tags.map((tag) => ({ tag })),
  crons: [],
  requiredSecrets: [],
  keepVars: false,
  workersDev: false,
  previewUrls: false,
  observability: {},
});

/** A release with core's migrations `coreTags`, on pi-durable `pi` (none when undefined). */
const release = (
  coreTags: readonly string[],
  pi?: string
): ReleaseManifest => ({
  manifestVersion: MANIFEST_VERSION,
  releaseId: "26.11.1",
  commit: "0".repeat(40),
  createdAt: "2026-11-27T09:00:00.000Z",
  notes: "feat(core): something",
  wranglerVersion: "4.0.0",
  compatibilityDate: "2026-09-15",
  packages: pi === undefined ? {} : { "@earendil-works/pi-durable": pi },
  workers: {
    core: worker("grasp-os-core", coreTags),
    connect: worker("grasp-os-connect", ["v1"]),
  },
  assets: {},
  modelFiles: [],
});

describe("moving a deployment between releases", () => {
  it("lets a deployment go forward, or back to a release with every migration its scripts ran", () => {
    const older = release(["v1", "v2"], "1.6.0");
    const newer = release(["v1", "v2", "v3"], "1.6.2");
    expect({
      forward: canMove(older, newer, { migrated: { core: "v2" } }),
      back: canMove(newer, older, { migrated: { core: "v2" } }),
      // A Worker that ran no migration holds nothing back.
      none: canMove(newer, older, { migrated: { core: null } }),
      // Nothing observed: nothing is known to hold it back.
      unobserved: canMove(newer, older, { migrated: {} }),
    }).toStrictEqual({
      forward: null,
      back: null,
      none: null,
      unobserved: null,
    });
  });

  it("refuses to take a script back past a Durable Object migration it ran, naming the Worker", () => {
    const older = release(["v1", "v2"], "1.6.0");
    const newer = release(["v1", "v2", "v3"], "1.6.0");
    expect({
      core: canMove(newer, older, { migrated: { core: "v3" } }),
      // A Worker the target lacks has none of its migrations.
      gone: canMove(newer, older, { migrated: { stray: "v1" } }),
    }).toStrictEqual({
      core: { reason: "behind_migration", worker: "core" },
      gone: { reason: "behind_migration", worker: "stray" },
    });
  });

  it("refuses a release that can't read the chats the running one stores, a patch apart or not", () => {
    const on = (pi?: string) => release(["v1"], pi);
    const observed = { migrated: {} };
    expect({
      olderMinor: canMove(on("1.6.0"), on("1.5.9"), observed),
      olderMajor: canMove(on("2.0.0"), on("1.9.0"), observed),
      withoutChats: canMove(on("1.6.0"), on(), observed),
      olderPatch: canMove(on("1.6.3"), on("1.6.0"), observed),
      newerMinor: canMove(on("1.5.0"), on("1.6.0"), observed),
      newerMajor: canMove(on("1.9.0"), on("2.0.0"), observed),
      fromNoChats: canMove(on(), on("1.0.0"), observed),
    }).toStrictEqual({
      olderMinor: { reason: "behind_chat_storage" },
      olderMajor: { reason: "behind_chat_storage" },
      withoutChats: { reason: "behind_chat_storage" },
      olderPatch: null,
      newerMinor: null,
      newerMajor: null,
      fromNoChats: null,
    });
  });

  it("names a migration it would go back past before chats it couldn't read", () => {
    const newer = release(["v1", "v2"], "1.6.0");
    const older = release(["v1"], "1.5.0");
    expect(canMove(newer, older, { migrated: { core: "v2" } })).toStrictEqual({
      reason: "behind_migration",
      worker: "core",
    });
  });
});

/** A release whose core binds DB with `migrations`, by name. */
const migrated = (migrations: readonly string[]): ReleaseManifest => {
  const base = release(["v1"]);
  const core = worker("grasp-os-core", ["v1"]);
  return {
    ...base,
    workers: {
      ...base.workers,
      core: {
        ...core,
        d1Databases: [
          {
            binding: "DB",
            databaseName: "grasp-os-core",
            migrations: migrations.map((name) => ({
              name,
              r2Key: `migrations/${name}`,
              sha256: "0".repeat(64),
              size: 1,
            })),
          },
        ],
      },
    },
  };
};

describe("what a deployment answers it runs", () => {
  const to = migrated(["0000_init.sql", "0001_more.sql"]);
  const later = migrated(["0000_init.sql", "0001_more.sql", "0002_later.sql"]);

  it("takes the release on its last migration, a database a later release took ahead of it, and a core that says nothing", () => {
    expect({
      exact: installMismatch(
        to,
        "core",
        { release: to.releaseId, schema: { DB: "0001_more.sql" } },
        []
      ),
      // A later release's migration: a release that goes back runs on it.
      ahead: installMismatch(
        to,
        "core",
        { release: to.releaseId, schema: { DB: "0002_later.sql" } },
        [later]
      ),
      // A core from before the probe said either.
      silent: installMismatch(to, "core", {}, []),
      // A release that migrates nothing holds no database to a name.
      none: installMismatch(migrated([]), "core", { schema: { DB: null } }, []),
    }).toStrictEqual({ exact: null, ahead: null, silent: null, none: null });
  });

  it("refuses another release or none, a database behind the release's last migration, and one at a migration no later release takes it to", () => {
    const elsewhere = migrated(["0000_other.sql", "0001_unrelated.sql"]);
    const schemaOff = { reason: "schema", binding: "DB" };
    expect({
      other: installMismatch(to, "core", { release: "26.11.0" }, []),
      unnamed: installMismatch(to, "core", { release: null }, []),
      behind: installMismatch(to, "core", { schema: { DB: "0000_init.sql" } }, [
        later,
      ]),
      empty: installMismatch(to, "core", { schema: { DB: null } }, [later]),
      // It answers for its databases, but not this one.
      unanswered: installMismatch(to, "core", { schema: {} }, [later]),
      // Ahead by no release the admin knows: another database.
      unknown: installMismatch(
        to,
        "core",
        { schema: { DB: "0002_later.sql" } },
        []
      ),
      // Listed by a later release, but not after this one's last: a
      // database of another lineage.
      unrelated: installMismatch(
        to,
        "core",
        { schema: { DB: "0001_unrelated.sql" } },
        [elsewhere]
      ),
    }).toStrictEqual({
      other: { reason: "release" },
      unnamed: { reason: "release" },
      behind: schemaOff,
      empty: schemaOff,
      unanswered: schemaOff,
      unknown: schemaOff,
      unrelated: schemaOff,
    });
  });
});

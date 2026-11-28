import type { ReleaseManifest } from "./release.ts";

// How one deployment goes from one release to another, wherever it runs:
// the steps in order, whether a move may be made at all, and whether what
// the deployment answers once moved is that release. Pure, with
// no Cloudflare API, so the admin applies a release to a hosted client by
// these rules and an on-premises install can apply one by them on plain
// workerd.

/**
 * A release's steps at one deployment, in order: check the move may be
 * made, keep a restore point of its data, migrate its databases (expand
 * only), install its Workers, and probe what answers.
 */
export const releaseSteps = [
  "preflight",
  "snapshot",
  "migrate",
  "install",
  "probe",
] as const;
export type ReleaseStep = (typeof releaseSteps)[number];

/**
 * The package that stores core's chats: pi-durable keeps a chat's records
 * in its Durable Object, each record at a version of its own, and a later
 * minor may write versions an earlier one refuses to read (Pi 1.6 did:
 * `pi.live` 3, `pi.tool` 4 and `pi.generation` 3, none of which Pi 1.4
 * opens). Chord and pi-schema are pinned with it, and move with it.
 */
const chatStorePackage = "@earendil-works/pi-durable";

/** A release's major and minor of pi-durable, as `packages` records it; null when it names none. */
const chatStorageOf = (
  manifest: ReleaseManifest
): readonly [number, number] | null => {
  const [major, minor] = (manifest.packages[chatStorePackage] ?? "")
    .split(".")
    .map(Number);
  return major === undefined ||
    minor === undefined ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor)
    ? null
    : [major, minor];
};

/**
 * Whether a deployment on release `to` still opens every chat its core
 * stored on release `from`: `to` runs at least `from`'s major and minor of
 * pi-durable. A patch never changes how chats are stored, and every minor
 * may, so each new minor is a boundary a deployment never goes back
 * across. Read from what every manifest has recorded since the first, the
 * installed versions of its packages, so it holds for releases imported
 * before this rule too. A release that names no pi-durable counts as
 * storing no chats, and one that names it never goes to one without it.
 */
const readsChatsOf = (to: ReleaseManifest, from: ReleaseManifest): boolean => {
  const stored = chatStorageOf(from);
  if (stored === null) {
    return true;
  }
  const reads = chatStorageOf(to);
  if (reads === null) {
    return false;
  }
  return reads[0] === stored[0] ? reads[1] >= stored[1] : reads[0] > stored[0];
};

/** What is known of a deployment beyond the release it runs. */
export interface ObservedDeployment {
  /**
   * The last Durable Object migration each Worker's script ran, by
   * Worker, as it was observed; null for one that ran none. A Worker left
   * out is not known to have run any.
   */
  migrated: Readonly<Record<string, string | null>>;
}

/**
 * Why a move is refused: `behind_migration`, `to` lacks a Durable Object
 * migration `worker`'s script ran, and a script never goes back past one;
 * `behind_chat_storage`, `to` can't read the chats `from` stores.
 */
export type MoveRefusal =
  | { reason: "behind_migration"; worker: string }
  | { reason: "behind_chat_storage" };

/**
 * Whether a deployment on release `from`, as `observed`, may go to
 * release `to`, newer or older: null when it may, else why not. Every
 * Durable Object migration a script ran must be in `to`, and `to` must
 * read the chats `from` stores.
 */
export const canMove = (
  from: ReleaseManifest,
  to: ReleaseManifest,
  observed: ObservedDeployment
): MoveRefusal | null => {
  const behind = Object.entries(observed.migrated).find(
    ([worker, tag]) =>
      tag !== null &&
      !(
        to.workers[worker]?.durableObjectMigrations.some(
          (step) => step.tag === tag
        ) ?? false
      )
  )?.[0];
  if (behind !== undefined) {
    return { reason: "behind_migration", worker: behind };
  }
  return readsChatsOf(to, from) ? null : { reason: "behind_chat_storage" };
};

/**
 * What a deployment's core says it runs, as its probe answers
 * (@grasp-os/shared/provision-probe): the release its deploy named, and
 * each database's last migration by binding. Either absent from a core
 * of a release from before it, which says nothing of it.
 */
export interface InstalledAnswer {
  release?: string | null;
  schema?: Readonly<Record<string, string | null>>;
}

/**
 * Why `answered` isn't release `to` installed, as Worker `worker` of it
 * says: `release`, it names another release or none; `schema`, the
 * database `binding` is behind `to`'s last migration for it. Null when
 * it is, or when it says nothing (a core from before it).
 *
 * A database is at `to` when its last migration is `to`'s last, or one
 * `to` doesn't list: a later release's, its schema ahead, as a release
 * that goes back runs on the schema of the one after it (migrations are
 * expand only). A migration `to` lists before its last, or none where it
 * lists some, is behind. A database the answer names none for, where it
 * names some, counts as having none.
 */
export const installMismatch = (
  to: ReleaseManifest,
  worker: string,
  answered: InstalledAnswer
): { reason: "release" } | { reason: "schema"; binding: string } | null => {
  if (answered.release !== undefined && answered.release !== to.releaseId) {
    return { reason: "release" };
  }
  const { schema } = answered;
  if (schema === undefined) {
    return null;
  }
  const behind = to.workers[worker]?.d1Databases.find(
    ({ binding, migrations }) => {
      const names = migrations.map(({ name }) => name);
      const last = names.at(-1);
      const at = schema[binding] ?? null;
      return (
        last !== undefined && at !== last && (at === null || names.includes(at))
      );
    }
  );
  return behind === undefined
    ? null
    : { reason: "schema", binding: behind.binding };
};

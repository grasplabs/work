import { compilerVersion, graphsOfModules } from "@grasp-os/compiler";
import { definitionText } from "@grasp-os/runtime/definition";
import type { AppDefinition } from "@grasp-os/runtime/definition";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { dependencyErrors } from "@grasp-os/shared/dependencies";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { draftSealFailures } from "@grasp-os/shared/functions";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

import { loadDraftRelease, sealDraftRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { appKind, draftDefinition } from "./apps.ts";
import {
  buildCachePrefix,
  inOrder,
  readCache,
  writeCache,
} from "./build-cache.ts";
import { filesOf } from "./drafts.ts";
import type { DraftState } from "./drafts.ts";
import { graphApproved, latestApproval } from "./packages/approvals.ts";
import { appCodeAndTestFiles } from "./pages.ts";

// A draft App sealed (app-releases.ts `sealDraftRelease`): its code and
// tests built, inspected and checked into the release the version it
// would become seals to, which its preview runs (draft-runs.ts). A seal
// takes seconds when its builds are cached and minutes when they aren't,
// so it is made once for what decides it and kept:
//
// - in R2, signed as the build cache's entries are (build-cache.ts), under
//   a key of exactly what decides the seal (`draftSealKey`), so a seal
//   outlives the isolate and the object that made it, and any isolate
//   reads it back rather than seal again;
// - made by the App's preview object alone (app-preview.ts `seal`), once
//   per key however many ask, from whichever isolate (`DraftSeals`): its
//   work belongs to the object, so a caller that goes, cancelled or past
//   its deadline, leaves it running for the next to read.
//
// What decides a seal, its key: the entry's format, the toolchain
// (`compilerVersion`: the compiler, the kit and the SDKs), the platform's
// release (`CF_VERSION_METADATA`: core's own sealing, the modules it
// generates and the release it packages), the App, the version it would
// become, its code and tests, its definition, and the App's approved
// packages (`latestApproval`), which its builds bundle. Pages are left
// out: a seal reads none, so a write of a page seals nothing again. A
// package approval revoked as malware since stops a sealed draft that
// bundles it from loading (`requireApprovedPackages`), as it stops a
// version (`loadRelease`).
//
// Threat model, on top of the preview's (draft-runs.ts):
//
// - A forged or changed entry in the bucket, to run other code than the
//   draft's: its MAC under a key derived from core's secret binds its text
//   to its key (build-cache.ts), and every byte is checked against the
//   manifest's hashes as it loads (`loadDraftRelease`); one that fails
//   either is a miss, logged, and the draft is sealed again over it.
// - One App's seal served for another: the key names the App, under a
//   prefix of its own, which the MAC binds; the object that seals is the
//   App's own and works out the key itself, never taking one from a
//   caller.
// - Someone who doesn't build the App: nothing here reads who asks. Every
//   way to a sealed draft (draft-runs.ts) checks that they build it first.
// - What a removed App leaves: its preview's discard deletes its seals
//   (`DraftSeals.forget`), and only that object writes them, never once it
//   discarded them: a read never rewrites one. The build cache's sweep
//   deletes any seal 30 days after it was made (pages.ts `sweepBuilds`),
//   and the next ask seals it again.

/** What a sealed draft's key and entry are made of; another is a miss. */
const draftSealFormat = 1;

/** Where an App's sealed drafts are kept, under the build cache's prefix. */
const sealsPrefix = (app: AppId): string =>
  `${buildCachePrefix}draft-seal/${app}/`;

/** A draft to seal: its code and tests alone, and its definition. */
export interface DraftSeal {
  readonly app: AppId;
  /** The version it would become. */
  readonly version: number;
  /** Its code and test files (pages.ts `appCodeAndTestFiles`), by path. */
  readonly files: Readonly<Record<string, string>>;
  readonly definition: AppDefinition;
}

/** A draft's files and definition, as its seal reads them. */
export interface DraftSource {
  readonly files: Map<string, string>;
  readonly definition: AppDefinition;
}

/**
 * `draft`'s files and definition (apps.ts); null for a draft of an App
 * with no version that holds nothing, which has nothing to seal.
 */
export const draftSource = async (
  env: Env,
  app: AppId,
  draft: DraftState
): Promise<DraftSource | null> => {
  const held = await draftDefinition(env, app, draft);
  return held === null
    ? null
    : {
        files: await filesOf(env, appKind, app, draft),
        definition: held.definition,
      };
};

/**
 * What of `source`, a draft of `app` as `version`, its seal reads: its
 * code and tests (`appCodeAndTestFiles`, the very selection its build and
 * check make), and its definition.
 */
export const sealOfSource = (
  app: AppId,
  version: number,
  { files, definition }: DraftSource
): DraftSeal => ({
  app,
  version,
  files: appCodeAndTestFiles(Object.fromEntries(files)),
  definition,
});

/** The graph of App `app`'s current package approval, if any (`latestApproval`). */
const approvalOf = async (
  env: Pick<Env, "DB">,
  app: AppId
): Promise<string | null> =>
  (await latestApproval(env, { type: "app", id: app })) ?? null;

/** `draftSealKey`, with the App's approved packages as given. */
const keyOf = async (
  env: Pick<Env, "CF_VERSION_METADATA">,
  seal: DraftSeal,
  packages: string | null
): Promise<string> => {
  const parts = [
    draftSealFormat,
    compilerVersion,
    env.CF_VERSION_METADATA?.id ?? null,
    seal.app,
    seal.version,
    inOrder(seal.files),
    definitionText(seal.definition),
    packages,
  ];
  return `${sealsPrefix(seal.app)}${await sha256Hex(JSON.stringify(parts))}.json`;
};

/**
 * Where `seal` is kept: the hash of everything that decides it (see the
 * header), so any change to one of them is another key.
 */
export const draftSealKey = async (
  env: Pick<Env, "DB" | "CF_VERSION_METADATA">,
  seal: DraftSeal
): Promise<string> => await keyOf(env, seal, await approvalOf(env, seal.app));

/** A sealed draft as its entry holds it: the manifest, and each artifact's text by hash. */
const entrySchema = z.strictObject({
  format: z.literal(draftSealFormat),
  manifest: z.string(),
  manifestHash: z.string(),
  artifacts: z.record(z.string(), z.string()),
});

/** What a sealed entry's manifest is read for: its artifacts' paths. */
const manifestPathsSchema = z.object({
  artifacts: z.array(z.object({ path: z.string() })),
});

/**
 * Whether the entry `text` bundles no approved packages but those of
 * graph `packages`: its builds read the App's approval themselves, which
 * may change while they run.
 */
const bundlesOnly = (text: string, packages: string | null): boolean => {
  const { manifest } = entrySchema.parse(JSON.parse(text));
  const { artifacts } = manifestPathsSchema.parse(JSON.parse(manifest));
  return graphsOfModules(
    artifacts.flatMap(({ path }) =>
      path.startsWith("modules/") ? [path.slice("modules/".length)] : []
    )
  ).every((graph) => graph === packages);
};

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * `seal` sealed (`sealDraftRelease`), as the text its entry keeps: throws
 * as the seal does, a draft's own failure (`draftSealFailures`) included.
 */
export const sealedEntry = async (
  env: Env,
  { app, version, files, definition }: DraftSeal
): Promise<string> => {
  const sealed = await sealDraftRelease(
    env,
    { app, version },
    new Map(Object.entries(files)),
    definition
  );
  return JSON.stringify({
    format: draftSealFormat,
    manifest: sealed.manifest,
    manifestHash: sealed.manifestHash,
    // A release's artifacts are text (app-releases.ts `artifactOf`).
    artifacts: Object.fromEntries(
      sealed.artifacts.map(({ sha256, bytes }) => [
        sha256,
        decoder.decode(bytes),
      ])
    ),
  });
};

/**
 * The release `text`, an entry of `seal`'s, holds, every byte checked
 * against its manifest (`loadDraftRelease`); undefined, logged, for one
 * of another format or that doesn't check.
 */
export const releaseOfEntry = async (
  seal: Pick<DraftSeal, "app" | "version">,
  text: string
): Promise<Release | undefined> => {
  let entry: z.infer<typeof entrySchema>;
  try {
    entry = entrySchema.parse(JSON.parse(text));
  } catch {
    log.warn("draft.seal_unread", { app: seal.app });
    return undefined;
  }
  const { artifacts } = entry;
  try {
    return await loadDraftRelease(
      { app: seal.app, version: seal.version },
      entry,
      async (sha256) =>
        await Promise.resolve(
          Object.hasOwn(artifacts, sha256)
            ? encoder.encode(artifacts[sha256])
            : undefined
        )
    );
  } catch (error) {
    if (versionErrors.codeOf(error) === undefined) {
      throw error;
    }
    log.error("draft.seal_corrupt", { app: seal.app, ...errorFields(error) });
    return undefined;
  }
};

/** The sealed draft kept under `key`, if one is that loads. */
export const keptRelease = async (
  env: Env,
  key: string,
  seal: Pick<DraftSeal, "app" | "version">
): Promise<{ text: string; release: Release } | undefined> => {
  // Never rewritten by a read: only the App's preview object writes it.
  const text = await readCache(env, key, { refresh: false });
  if (text === undefined) {
    return undefined;
  }
  const release = await releaseOfEntry(seal, text);
  return release === undefined ? undefined : { text, release };
};

/**
 * Refuses `release` while any approved package graph it bundles is no
 * longer in force (revoked as malware since, rescan.ts): as a version's
 * load does (`loadRelease`), checked at every use.
 */
export const requireApprovedPackages = async (
  env: Env,
  release: Release
): Promise<void> => {
  for (const graph of graphsOfModules(Object.keys(release.modules))) {
    // oxlint-disable-next-line no-await-in-loop -- one graph a release, at most
    if (!(await graphApproved(env, graph))) {
      throw dependencyErrors.create("dependency.revoked");
    }
  }
};

/** How many keys a preview object remembers it kept, so a change that seals nothing new reads nothing. */
const doneMax = 16;

/** How long a draft's own seal failure answers for it before it is sealed again. */
const failureKeptMs = 60_000;

/**
 * The seals of one App's drafts, made in its preview object
 * (app-preview.ts): one per key, shared by every ask while it runs, from
 * any isolate, and kept in R2 once made. Nothing runs under the object's
 * `blockConcurrencyWhile` and nothing is written to its storage: a seal
 * awaits builds and the sandbox, never the object's storage, so the
 * object takes its other calls meanwhile. A seal goes on when the call
 * that started it goes; one the object's restart cut short is started
 * again by the next ask, as nothing of it was kept but the entry, which
 * it writes last.
 *
 * A draft that doesn't seal for its own fault (`draftSealFailures`: its
 * code doesn't build, throws as it registers, or declares what it
 * doesn't register) is answered so for a minute, however many calls and
 * live queries ask, rather than inspected again for each; anything else
 * (the sandbox away, the object reset) is never kept.
 */
export class DraftSeals {
  /** The seals running now, by key: shared within the object alone. */
  readonly #running = new Map<string, Promise<string>>();
  /** The draft's own failures, by key, and until when each answers. */
  readonly #failed = new Map<string, { error: Error; until: number }>();
  /** The keys sealed or found kept lately, the latest last: nothing to prepare. */
  readonly #done = new Set<string>();
  /** Whether a prepare runs now. */
  #preparing = false;
  /** Whether the draft changed while one ran, to be read again after it. */
  #again = false;
  /** Whether the App was removed: nothing is kept for it any more. */
  #discarded = false;

  /** The entry of `seal`, kept or made now (see above). */
  async seal(env: Env, seal: DraftSeal): Promise<string> {
    const packages = await approvalOf(env, seal.app);
    const key = await keyOf(env, seal, packages);
    const now = Date.now();
    for (const [failedKey, { until }] of this.#failed) {
      if (until <= now) {
        this.#failed.delete(failedKey);
      }
    }
    const failed = this.#failed.get(key);
    if (failed !== undefined) {
      throw failed.error;
    }
    const running =
      this.#running.get(key) ?? this.#start(env, key, seal, packages);
    return await running;
  }

  /**
   * Seals what `shown` reads, the draft as it is now, unless it is sealed
   * already: the draft changed (drafts.ts), so that opening or calling it
   * finds it sealed. One prepare at a time: a change while one runs has
   * the draft read again once it settled, so of a burst of writes only
   * the first and the last are sealed, never each in between. Answers
   * once none is left; never throws (logged), as the next to need a seal
   * makes it.
   */
  async prepare(
    env: Env,
    shown: () => Promise<DraftSeal | null>
  ): Promise<void> {
    if (this.#preparing) {
      this.#again = true;
      return;
    }
    this.#preparing = true;
    try {
      do {
        this.#again = false;
        // oxlint-disable-next-line no-await-in-loop -- one after the other, by design
        await this.#prepareNow(env, shown);
      } while (this.#again);
    } finally {
      this.#preparing = false;
    }
  }

  /** Seals what `shown` reads unless it is sealed (`prepare`). */
  async #prepareNow(
    env: Env,
    shown: () => Promise<DraftSeal | null>
  ): Promise<void> {
    try {
      const seal = await shown();
      if (seal !== null && !this.#done.has(await draftSealKey(env, seal))) {
        await this.seal(env, seal);
      }
    } catch (error) {
      // A draft's own failure is kept by `seal`; anything else is the
      // next ask's to meet.
      if (!(isExpectedError(error) && draftSealFailures.has(error.code))) {
        log.warn("draft.seal_unprepared", errorFields(error));
      }
    }
  }

  /**
   * Deletes every sealed draft of `app`, and keeps none from now on, a
   * seal under way included: its App was removed (app-removal.ts).
   */
  async forget(env: Pick<Env, "FILES">, app: AppId): Promise<void> {
    this.#discarded = true;
    let cursor: string | undefined = undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- one page after the other
      const listed: R2Objects = await env.FILES.list({
        prefix: sealsPrefix(app),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (listed.objects.length > 0) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await env.FILES.delete(listed.objects.map(({ key }) => key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);
  }

  /** Notes that `key` is kept in R2, as the latest. */
  #kept(key: string): void {
    this.#done.delete(key);
    this.#done.add(key);
    if (this.#done.size > doneMax) {
      const [oldest] = this.#done;
      if (oldest !== undefined) {
        this.#done.delete(oldest);
      }
    }
  }

  /** Starts the seal of `seal` under `key`, sharing it until it settles. */
  async #start(
    env: Env,
    key: string,
    seal: DraftSeal,
    /** The approved packages `key` names. */
    packages: string | null
  ): Promise<string> {
    const work = (async (): Promise<string> => {
      const started = Date.now();
      try {
        // Kept already: by an ask before this one, or a seal before the
        // object's restart.
        const kept = await keptRelease(env, key, seal);
        if (kept !== undefined) {
          this.#kept(key);
          return kept.text;
        }
        let text: string;
        try {
          text = await sealedEntry(env, seal);
          // Sealed while the App's approval changed and changed back: its
          // builds bundled another's packages than the key names. Sealed
          // again, once.
          if (!bundlesOnly(text, packages)) {
            text = await sealedEntry(env, seal);
          }
          if (!bundlesOnly(text, packages)) {
            throw new Error(
              "The App's approved packages kept changing while its draft was sealed."
            );
          }
        } catch (error) {
          const own =
            isExpectedError(error) && draftSealFailures.has(error.code);
          if (own) {
            this.#failed.set(key, {
              error,
              until: Date.now() + failureKeptMs,
            });
          }
          log.info("draft.seal", {
            outcome: own ? error.code : "failed",
            ms: Date.now() - started,
          });
          throw error;
        }
        if (!this.#discarded) {
          await writeCache(env, key, text);
          this.#kept(key);
        }
        // How long a seal takes, made: what a caller's deadline is set against.
        log.info("draft.seal", {
          outcome: "sealed",
          ms: Date.now() - started,
          bytes: text.length,
        });
        return text;
      } finally {
        this.#running.delete(key);
      }
    })();
    this.#running.set(key, work);
    return await work;
  }
}

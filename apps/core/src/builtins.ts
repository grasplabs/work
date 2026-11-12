import knowledgeMigrations from "@grasp-os/brain/migrations/journal" with { type: "json" };
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { CatalogContractDefinition } from "@grasp-os/shared/workflow-resources";
import { DurableObject } from "cloudflare:workers";

import type { BuiltinBlueprint } from "#blueprints";
import blueprintsDigest from "#blueprints-digest";

import { installBuiltinBlueprint } from "./app-blueprints.ts";
import { installShippedSkills } from "./brain-skills.ts";
import coreMigrations from "./db/core/migrations/meta/_journal.json" with { type: "json" };
import { inJurisdiction } from "./durable-objects.ts";
import { syncGraspSkills } from "./knowledge/grasp-skills.ts";
import { releaseContracts } from "./release-contracts.ts";
import { shippedSkills } from "./shipped-skills.ts";
import type { ShippedSkill } from "./shipped-skills.ts";
import { ensureReleaseContract } from "./workflow-catalog.ts";

// What ships with the release, installed once per release on the first
// request: the built-in blueprints
// (apps/core/blueprints/, embedded by build-blueprints.ts, each installed
// as a blueprint like any other, app-blueprints.ts), the general catalog
// contracts (release-contracts.ts), and the Grasp skills, into Knowledge
// (knowledge/grasp-skills.ts) and the Brain (brain-skills.ts), until the
// cutover (GRA-1735) leaves the Brain alone. Workers have no deploy hook, so the first
// request core serves after the router's check starts the install, in the
// background (`installBuiltinsOnce`), once per isolate.
//
// One object does the installing, the `Builtins` singleton. It keeps the
// fingerprint of the release it last installed completely, a SHA-256 of
// everything the install writes; an unchanged release does nothing beyond
// comparing it. Callers who arrive while it installs share that install.
// The fingerprint is stored only once everything is in, so a partial
// install (a blueprint or a skill that failed, the object evicted
// halfway) is tried again by the next request that starts one. Each part
// compares what is stored before it writes (a blueprint its files, a
// skill its text), so trying again writes only what is still missing.
//
// Which release wins while two run side by side, during a gradual
// rollout: the one the object runs. It installs its own release, never
// the caller's, and a Durable Object runs one version at a time: each
// deployment assigns each object a version. As long as each gradual
// deployment lists the versions in the same order as the one before and
// only raises the new version's share, Cloudflare never moves an object
// back to a version it left, so the installed text changes once when the
// object moves to the new release, never back and forth. The admin's
// deploys, as a release moves from Edge to Beta to Stable, must keep to
// that. A rollback installs the older release again, as it should. On-prem
// runs one version.
//
// An isolate counts the install as done only once the object has
// installed the isolate's own release (`ensureInstalled` compares the
// fingerprints): an isolate of the new release that reaches an object
// still on the old one asks again later, rather than never.

/**
 * What a release's fingerprint is made of: its blueprints by their digest
 * (src/builtin-digest.ts), its general catalog contracts, and its skills.
 */
export interface ReleaseFingerprint {
  blueprintsDigest: string;
  contracts: readonly CatalogContractDefinition[];
  /** Grasp's own skills, each by its name (shipped-skills.ts). */
  skills: readonly ShippedSkill[];
}

/** What a release installs: this one's unless a test passes another. */
export interface Release extends ReleaseFingerprint {
  blueprints: readonly BuiltinBlueprint[];
}

/**
 * This release's fingerprint, without its blueprints: the build works out
 * their digest, so an isolate checks the install without loading them.
 */
export const thisRelease: ReleaseFingerprint = {
  blueprintsDigest,
  contracts: releaseContracts,
  skills: shippedSkills,
};

/**
 * This release's built-ins. Only the singleton loads the blueprints to
 * install them: a few hundred KB of text (GRA-1349), which nothing else
 * loads.
 */
export const loadBuiltinRelease = async (): Promise<Release> => {
  const { default: blueprints } = await import("#blueprints");
  return { ...thisRelease, blueprints };
};

/** Where the singleton keeps the fingerprint of what it installed. */
const installedKey = "installed";

/**
 * Installs each built-in blueprint, one at a time (each is
 * one batch, well within D1's limits). A blueprint that fails is logged,
 * and the others are still installed. Resolves whether all of them are.
 */
const installBlueprints = async (
  env: Env,
  blueprints: readonly BuiltinBlueprint[]
): Promise<boolean> => {
  let complete = true;
  for (const blueprint of blueprints) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
      await installBuiltinBlueprint(env, blueprint);
    } catch (error) {
      complete = false;
      log.error("builtins.blueprint_failed", {
        blueprint: blueprint.id,
        ...errorFields(error),
      });
    }
  }
  return complete;
};

/**
 * Publishes each of the release's general catalog contracts whose key
 * isn't taken yet, one at a time. One that fails is logged, and the
 * others are still published. Resolves whether all of them are.
 */
const installContracts = async (
  env: Env,
  contracts: readonly CatalogContractDefinition[]
): Promise<boolean> => {
  let complete = true;
  for (const contract of contracts) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
      await ensureReleaseContract(env, contract, { builtin: "release" });
    } catch (error) {
      complete = false;
      log.error("builtins.contract_failed", {
        contract: contract.key,
        ...errorFields(error),
      });
    }
  }
  return complete;
};

/**
 * The core and Knowledge databases' latest migrations: part of the
 * fingerprint, so a release that changes either schema installs again, as
 * what the install writes may have moved or been cleared, such as the
 * Grasp skills (a migration can't reach the fingerprint, which lives in
 * the singleton's storage).
 */
const coreSchema = coreMigrations.entries.at(-1)?.tag ?? null;
const knowledgeSchema = knowledgeMigrations.entries.at(-1)?.tag ?? null;

/** The fingerprint of what installing `of` writes. */
export const fingerprintOf = async (of: ReleaseFingerprint): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      schema: coreSchema,
      knowledgeSchema,
      blueprints: of.blueprintsDigest,
      contracts: of.contracts,
      skills: of.skills.map(({ name, text }) => ({ name, text })),
      // The skills go into the Brain too (GRA-1826): a release whose
      // skills didn't change installs them there once.
      skillsIn: ["knowledge", "brain"],
    })
  );

/**
 * Installs `of` unless `storage` holds its fingerprint already, and stores
 * the fingerprint once all of it is in. Resolves whether it is all in.
 * The singleton runs it; tests run it on its storage with another env.
 */
export const installBuiltins = async (
  env: Env,
  storage: Pick<DurableObjectStorage, "get" | "put">,
  of: Release
): Promise<boolean> => {
  const fingerprint = await fingerprintOf(of);
  if ((await storage.get(installedKey)) === fingerprint) {
    return true;
  }
  const blueprints = await installBlueprints(env, of.blueprints);
  const contracts = await installContracts(env, of.contracts);
  // Knowledge keeps each at `<name>/SKILL.md`, until the cutover.
  const skills = await syncGraspSkills(
    env,
    of.skills.map(({ name, text }) => ({ path: `${name}/SKILL.md`, text }))
  );
  const brainSkills = await installShippedSkills(env, of.skills);
  const complete = blueprints && contracts && skills && brainSkills;
  if (complete) {
    await storage.put(installedKey, fingerprint);
  }
  log.info("builtins.installed", {
    outcome: complete ? "complete" : "partial",
  });
  return complete;
};

/** The singleton that installs the release's built-ins. */
export class Builtins extends DurableObject<Env> {
  #installing: Promise<boolean> | undefined;

  /**
   * Installs this object's release's built-ins if they aren't yet, sharing
   * an install already under way. Resolves whether what is installed now
   * is the caller's release, its fingerprint `expected`: `false` for a
   * partial install, or for an object running another release, and the
   * caller asks again later.
   */
  async ensureInstalled(expected: string): Promise<boolean> {
    this.#installing ??= this.#install();
    const complete = await this.#installing;
    return complete && (await this.ctx.storage.get(installedKey)) === expected;
  }

  async #install(): Promise<boolean> {
    try {
      return await installBuiltins(
        this.env,
        this.ctx.storage,
        await loadBuiltinRelease()
      );
    } finally {
      this.#installing = undefined;
    }
  }
}

/** The one `Builtins` object. */
export const builtins = (
  env: Pick<Env, "BUILTINS" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectStub<Builtins> =>
  inJurisdiction(env, env.BUILTINS).getByName("builtins");

/**
 * How long an isolate waits after a partial or failed install before a
 * request starts another: a built-in that fails every time is tried once
 * a minute per isolate, not on every request.
 */
export const builtinsRetryMs = 60_000;

/**
 * An isolate's installer of release `of`'s built-ins: it starts installing
 * them in the background, once per isolate. After a partial or failed
 * install, or one of another release than `of`, the first request
 * `builtinsRetryMs` later starts another; the singleton makes that one
 * comparison once everything is in. Core has one, `installBuiltinsOnce`;
 * tests make others, each for an isolate of their own.
 */
export const builtinsInstaller = (of: ReleaseFingerprint = thisRelease) => {
  // `started` while an install is under way or `of` is in, and when the
  // next may start after one that wasn't.
  const isolate = { started: false, retryAt: 0 };
  return (env: Env, ctx: Pick<ExecutionContext, "waitUntil">): void => {
    if (isolate.started || Date.now() < isolate.retryAt) {
      return;
    }
    isolate.started = true;
    const install = async (): Promise<void> => {
      let complete = false;
      try {
        const expected = await fingerprintOf(of);
        complete = await builtins(env).ensureInstalled(expected);
      } catch (error) {
        log.error("builtins.install_failed", errorFields(error));
      }
      isolate.started = complete;
      if (!complete) {
        isolate.retryAt = Date.now() + builtinsRetryMs;
      }
    };
    ctx.waitUntil(install());
  };
};

/** This isolate's installer, which the first request core serves starts. */
export const installBuiltinsOnce = builtinsInstaller();

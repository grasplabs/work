import { and, asc, eq } from "drizzle-orm";

import { allowedFor } from "./authorize.ts";
import type { Brain, SkillAuthority } from "./brain.ts";
import {
  brainContractVersion,
  brainErrors,
  skillManifestSchema,
  skillsReadInputSchema,
  skillsSelectInputSchema,
} from "./contract.ts";
import type {
  SkillDependency,
  SkillManifest,
  SkillOutcome,
  SkillRead,
  SkillRef,
  SkillReference,
  SkillSelection,
} from "./contract.ts";
import { inList } from "./db/d1.ts";
import {
  brainPayloads,
  collections,
  documents,
  versions,
} from "./db/schema.ts";
import { getDocument } from "./documents.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { collectionIdSchema, documentIdSchema } from "./ids.ts";
import { readPayload } from "./payloads.ts";
import { asBrainError } from "./recall.ts";

// Skills (GRA-310; the Brain design's `skills.select` / `skills.read`):
// which accepted skill applies to a task, pinned at the version read, or
// an explicit no-skill result; and a pinned skill read at exactly that
// version. The Brain knows no skill and no task: a skill is a `skill`
// document whose frontmatter carries its manifest (contract.ts
// `skillManifestSchema`), the words in it are the host's, and the rules
// below are the same for every word.
//
// Threat model, and how each is closed:
// - Selection creating permissions: a skill's `requires` are compared with
//   the capabilities the host says the caller holds (`skills.capabilities`
//   port); a skill needing one they lack is never selected. Selection
//   reads only skills the caller may read (`allowedFor`, inside the SQL),
//   so it never names, let alone selects, one in a collection they can't.
// - Someone who can write a collection taking over selection: only skills
//   in collections the host vouches for (`skills.authorityOf`: core's
//   shipped skills, and collections only admins write) are selected,
//   referred to or replaced. A prerequisite or dependency resolves in the
//   skill's own collection, or the collection it names, never by name
//   across collections; a name twice there is ambiguous, never "the one
//   the caller reads". `replaces` reaches a skill in the same collection,
//   or, from a collection only admins write, a shipped skill.
// - A missing prerequisite or dependency: each must be accepted and usable
//   by the caller (a prerequisite), or that one skill, with that name and
//   accepted, at exactly the version named (a dependency), or the skill
//   isn't selected, with why.
// - Forcing a skill: applicability is exact (the task's type in `tasks`,
//   every `when` trait held, no `unless` trait); a skill without `tasks`
//   applies to nothing; two that apply, with nothing saying which, select
//   none. No similarity, no order, no model.
// - A partial view: past `skillsReadMax` selectable skills a selection
//   reads none, rather than choose from some and miss an ambiguity.
// - A pin changing under a run: the selection pins the version it read;
//   `readSkill` returns exactly that version, retired or superseded since,
//   while the caller may still read it.
// - Unrecorded selections: every one, a no-skill one too, is recorded by
//   the host's `onRead` port with its result and counts, never a skill's
//   text.
// - Cost: a version's text never changes, so its parsed manifest is kept
//   by its payload's hash (`manifests`), for this isolate's later calls.

/** The rules a selection follows: exact matching over manifests. */
export const skillSelectionPolicyVersion = "rules@2";

/** Most selectable skills one selection reads; more selects none. */
export const skillsReadMax = 100;

/** Most collections holding readable skills it asks about; more selects none. */
const skillsScanMax = 1000;

/** A selectable skill, as a selection reads it. */
interface Candidate {
  ref: SkillRef;
  manifest: SkillManifest;
  /** Why its collection's skills may be selected. */
  authority: SkillAuthority;
  /** The collection it is in, and whether that one is sensitive. */
  source: { id: string; sensitive: boolean };
}

/** A parsed manifest, with the skill's name; null for text that isn't a skill's. */
type Parsed = { name: string; manifest: SkillManifest } | null;

/** Most parsed manifests kept: each is small, and a version never changes. */
const manifestsKept = 1000;

/** Parsed manifests by payload hash and path: a version's text never changes. */
const manifests = new Map<string, Parsed>();

/** The skill manifest in `text`'s frontmatter, with its name; null when it doesn't parse as a skill. */
const manifestOf = (path: string, text: string): Parsed => {
  try {
    const { type, frontmatter } = parseFrontmatter(path, text);
    const manifest = skillManifestSchema.safeParse(frontmatter);
    const name: unknown = Reflect.get(frontmatter, "name");
    return type === "skill" && manifest.success && typeof name === "string"
      ? { name, manifest: manifest.data }
      : null;
  } catch {
    return null;
  }
};

/** The manifest of the payload `payload` at `path`, parsed once per isolate. */
const manifestAt = async <C>(
  brain: Brain<C>,
  path: string,
  payload: { key: string; sha256: string }
): Promise<Parsed> => {
  const key = `${payload.sha256}\u0000${path}`;
  const kept = manifests.get(key);
  if (kept !== undefined) {
    return kept;
  }
  const parsed = manifestOf(path, await readPayload(brain, payload));
  if (manifests.size >= manifestsKept) {
    manifests.clear();
  }
  manifests.set(key, parsed);
  return parsed;
};

/**
 * The selectable skills `reader` may read, at their current versions, in a
 * fixed order: those in collections the host vouches for; undefined past
 * `skillsReadMax`.
 */
const selectableSkills = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<{ candidates: Candidate[]; read: number } | undefined> => {
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  // The collections holding skills the reader may read, vouched for first,
  // so only theirs are scanned: a collection anyone may fill with skills
  // never uses up the cap below and so never stops a selection.
  const held = await db
    .selectDistinct({
      id: collections.id,
      access: collections.access,
      owner: collections.owner,
      source: collections.source,
    })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(and(eq(documents.type, "skill"), allowed.documents()))
    .limit(skillsScanMax + 1);
  if (held.length > skillsScanMax) {
    return undefined;
  }
  const authorities = await brain.ports.skills.authorityOf(held);
  const vouchedIds = Object.keys(authorities).filter((id) =>
    held.some((collection) => collection.id === id)
  );
  if (vouchedIds.length === 0) {
    return { candidates: [], read: 0 };
  }
  const vouched = await db
    .select({
      id: documents.id,
      path: documents.path,
      version: documents.currentVersion,
      collection: { id: collections.id, sensitive: collections.sensitive },
      payload: { key: brainPayloads.key, sha256: brainPayloads.sha256 },
    })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .innerJoin(
      versions,
      and(
        eq(versions.documentId, documents.id),
        eq(versions.number, documents.currentVersion)
      )
    )
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .where(
      and(
        eq(documents.type, "skill"),
        allowed.documents(),
        inList(collections.id, vouchedIds)
      )
    )
    .orderBy(asc(collections.id), asc(documents.path))
    .limit(skillsReadMax + 1);
  if (vouched.length > skillsReadMax) {
    return undefined;
  }
  const candidates: Candidate[] = [];
  for (const row of vouched) {
    // oxlint-disable-next-line no-await-in-loop -- bounded by skillsReadMax, in order
    const parsed = await manifestAt(brain, row.path, row.payload);
    const authority = authorities[row.collection.id];
    if (parsed !== null && authority !== undefined) {
      candidates.push({
        ref: {
          documentId: documentIdSchema.parse(row.id),
          collectionId: collectionIdSchema.parse(row.collection.id),
          name: parsed.name,
          version: row.version,
        },
        manifest: parsed.manifest,
        authority,
        source: { id: row.collection.id, sensitive: row.collection.sensitive },
      });
    }
  }
  return { candidates, read: vouched.length };
};

/** Whether every one of `needed` is in `held`. */
const allIn = (needed: readonly string[], held: ReadonlySet<string>) =>
  needed.every((each) => held.has(each));

/**
 * The one selectable skill `reference` names, from `from`: by name in its
 * own collection, or in the collection named. Undefined when there is
 * none, or more than one of that name there.
 */
const resolved = (
  from: Candidate,
  reference: { collection?: string; name: string },
  all: readonly Candidate[]
): Candidate | undefined => {
  const collection = reference.collection ?? from.ref.collectionId;
  const named = all.filter(
    ({ ref }) =>
      ref.collectionId === collection &&
      ref.name === reference.name &&
      ref.documentId !== from.ref.documentId
  );
  return named.length === 1 ? named[0] : undefined;
};

/** A reference as `resolved` takes it. */
const referenceOf = (
  reference: SkillReference
): { collection?: string; name: string } =>
  typeof reference === "string" ? { name: reference } : reference;

/** A dependency as `resolved` takes it, with the version it pins. */
const dependencyOf = (
  dependency: SkillDependency
): { collection?: string; name: string; version: number } => {
  if (typeof dependency !== "string") {
    return dependency;
  }
  const [name = "", version = "0"] = dependency.split("@");
  return { name, version: Number(version) };
};

/** A dependency resolved to the skill and version it pins, or why not. */
type Pin = { ref: SkillRef } | undefined;

/**
 * The skill `dependency` of `from` pins, at exactly its version: the one
 * selectable skill of that name where it says, which has that version,
 * a skill of that name and accepted at it. Undefined otherwise.
 */
const pinOf = async <C>(
  brain: Brain<C>,
  from: Candidate,
  dependency: SkillDependency,
  all: readonly Candidate[]
): Promise<Pin> => {
  const wanted = dependencyOf(dependency);
  const target = resolved(from, wanted, all);
  if (target === undefined || wanted.version > target.ref.version) {
    return undefined;
  }
  const row = await brain.db
    .select({
      path: documents.path,
      payload: { key: brainPayloads.key, sha256: brainPayloads.sha256 },
    })
    .from(versions)
    .innerJoin(documents, eq(documents.id, versions.documentId))
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .where(
      and(
        eq(versions.documentId, target.ref.documentId),
        eq(versions.number, wanted.version)
      )
    )
    .get();
  const atVersion =
    row === undefined ? null : await manifestAt(brain, row.path, row.payload);
  return atVersion?.name === wanted.name &&
    atVersion.manifest.status === "accepted"
    ? { ref: { ...target.ref, version: wanted.version } }
    : undefined;
};

/**
 * Why `candidate` can't be used for the task, or the pins of its
 * dependencies when it applies, by the rules in order: retired, excluded,
 * a precondition, a capability, a prerequisite, a dependency.
 */
const checkedOf = async <C>(
  brain: Brain<C>,
  candidate: Candidate,
  traits: ReadonlySet<string>,
  held: ReadonlySet<string>,
  all: readonly Candidate[]
): Promise<{ blocked: SkillOutcome } | { pins: SkillRef[] }> => {
  const { manifest } = candidate;
  if (manifest.status === "retired") {
    return { blocked: "retired" };
  }
  if (manifest.unless.some((trait) => traits.has(trait))) {
    return { blocked: "excluded" };
  }
  if (!allIn(manifest.when, traits)) {
    return { blocked: "precondition_unmet" };
  }
  if (!allIn(manifest.requires, held)) {
    return { blocked: "missing_capability" };
  }
  const usable = manifest.prerequisites.every((reference) => {
    const found = resolved(candidate, referenceOf(reference), all);
    return (
      found !== undefined &&
      found.manifest.status === "accepted" &&
      allIn(found.manifest.requires, held)
    );
  });
  if (!usable) {
    return { blocked: "prerequisite_missing" };
  }
  const pins: SkillRef[] = [];
  for (const dependency of manifest.dependencies) {
    // oxlint-disable-next-line no-await-in-loop -- a few, bounded by the manifest
    const pin = await pinOf(brain, candidate, dependency, all);
    if (pin === undefined) {
      return { blocked: "dependency_missing" };
    }
    pins.push(pin.ref);
  }
  return { pins };
};

/** Whether `by` may take `target`'s place: in its own collection, or an admins' skill a shipped one. */
const mayReplace = (by: Candidate, target: Candidate): boolean =>
  by.ref.collectionId === target.ref.collectionId ||
  (by.authority === "admins" && target.authority === "shipped");

/**
 * Each of the skills `relevant` to the task, with why it was or wasn't
 * selected, and the one left applicable, with its dependencies' pins, once
 * `replaces` is applied: one is selected, more are each ambiguous.
 */
const outcomesOf = async <C>(
  brain: Brain<C>,
  relevant: readonly Candidate[],
  all: readonly Candidate[],
  traits: ReadonlySet<string>,
  held: ReadonlySet<string>
): Promise<{
  outcomes: Map<Candidate, SkillOutcome>;
  left: { candidate: Candidate; pins: SkillRef[] }[];
}> => {
  const outcomes = new Map<Candidate, SkillOutcome>();
  const applicable: { candidate: Candidate; pins: SkillRef[] }[] = [];
  for (const candidate of relevant) {
    // oxlint-disable-next-line no-await-in-loop -- in order, bounded by skillsReadMax
    const checked = await checkedOf(brain, candidate, traits, held, all);
    if ("blocked" in checked) {
      outcomes.set(candidate, checked.blocked);
    } else {
      applicable.push({ candidate, pins: checked.pins });
    }
  }
  // Where both apply, one that another may replace, and names, gives way.
  for (const { candidate: target } of applicable) {
    const replacedBy = applicable.some(
      ({ candidate: by }) =>
        by !== target &&
        by.manifest.replaces.includes(target.ref.name) &&
        mayReplace(by, target)
    );
    if (replacedBy) {
      outcomes.set(target, "replaced");
    }
  }
  const left = applicable.filter(({ candidate }) => !outcomes.has(candidate));
  for (const { candidate } of left) {
    outcomes.set(candidate, left.length === 1 ? "selected" : "ambiguous");
  }
  return { outcomes, left };
};

/** The selection's result: the one skill left, pinned, or why none. */
const resultOf = (
  incomplete: boolean,
  left: readonly { candidate: Candidate; pins: SkillRef[] }[]
): SkillSelection["result"] => {
  const [chosen] = left;
  if (incomplete) {
    return { kind: "none", reason: "incomplete" };
  }
  if (left.length > 1) {
    return { kind: "none", reason: "ambiguous" };
  }
  return chosen === undefined
    ? { kind: "none", reason: "no_match" }
    : { kind: "skill", skill: chosen.candidate.ref, dependencies: chosen.pins };
};

/**
 * The applicable skill for `input`'s task, for `reader`, pinned at the
 * version read, or an explicit no-skill result; recorded either way.
 * Refused as the Brain refuses a recall (`brain.denied` for a caller the
 * host doesn't let use the Brain, `brain.invalid` for a malformed task).
 */
export const selectSkill = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<SkillSelection> => {
  try {
    const { task } = brainErrors.parse(
      "brain.invalid",
      skillsSelectInputSchema,
      input
    );
    await brain.ports.recall.require(reader);
    const traits = new Set(task.traits);
    const held = new Set(await brain.ports.skills.capabilities(reader));
    const selectable = await selectableSkills(brain, reader);
    const all = selectable?.candidates ?? [];
    const relevant = all.filter(({ manifest }) =>
      manifest.tasks.includes(task.type)
    );
    const { outcomes, left } = await outcomesOf(
      brain,
      relevant,
      all,
      traits,
      held
    );
    const result = resultOf(selectable === undefined, left);
    // Recorded with its result and counts, as the host records a read: the
    // empty, ambiguous and no-skill ones too.
    await brain.ports.onRead(
      reader,
      {
        action: "knowledge.skill.select",
        documentIds: relevant.map(({ ref }) => ref.documentId),
        detail: {
          task: task.type,
          result: result.kind,
          reason: result.kind === "none" ? result.reason : null,
          skill: result.kind === "skill" ? result.skill.documentId : null,
          version: result.kind === "skill" ? result.skill.version : null,
          considered: relevant.length,
          read: selectable?.read ?? skillsReadMax + 1,
        },
      },
      ...all.map(({ source }) => source)
    );
    return {
      id: crypto.randomUUID(),
      contractVersion: brainContractVersion,
      selectionPolicyVersion: skillSelectionPolicyVersion,
      result,
      considered: relevant.flatMap((candidate) => {
        const outcome = outcomes.get(candidate);
        return outcome === undefined ? [] : [{ skill: candidate.ref, outcome }];
      }),
      createdAt: brain.ports.clock().toISOString(),
    };
  } catch (error) {
    throw asBrainError(brain, error);
  }
};

/**
 * The skill `input` pins, at exactly that version, for `reader`, while
 * they may still read it: retired or superseded since, it is the same
 * text. `brain.not_found` for a document that isn't a skill, a version
 * that isn't there, or one they can't read now.
 */
export const readSkill = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<SkillRead> => {
  try {
    const { documentId, version } = brainErrors.parse(
      "brain.invalid",
      skillsReadInputSchema,
      input
    );
    await brain.ports.recall.require(reader);
    const read = await getDocument(brain, reader, documentId, version);
    if (read.type !== "skill") {
      throw brainErrors.create("brain.not_found");
    }
    const parsed = manifestOf(read.path, read.version.text);
    return {
      skill: {
        documentId: read.id,
        collectionId: read.collectionId,
        name: parsed?.name ?? read.title,
        version: read.version.number,
      },
      manifest: parsed?.manifest ?? null,
      text: read.version.text,
    };
  } catch (error) {
    throw asBrainError(brain, error);
  }
};

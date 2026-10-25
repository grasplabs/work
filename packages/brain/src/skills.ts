import { and, asc, eq } from "drizzle-orm";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import {
  brainContractVersion,
  brainErrors,
  skillManifestSchema,
  skillsReadInputSchema,
  skillsSelectInputSchema,
} from "./contract.ts";
import type {
  SkillManifest,
  SkillOutcome,
  SkillRead,
  SkillRef,
  SkillSelection,
} from "./contract.ts";
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
// - A missing prerequisite or dependency: each must be accepted and usable
//   by the caller (a prerequisite) or readable at exactly its version (a
//   dependency), or the skill isn't selected, with why.
// - Forcing a skill: applicability is exact (the task's type in `tasks`,
//   every `when` trait held, no `unless` trait); a skill without `tasks`
//   applies to nothing; two that apply, with nothing saying which
//   (`replaces`), select none. No similarity, no order, no model.
// - A partial view: past `skillsReadMax` readable skills a selection
//   reads none, rather than choose from some and miss an ambiguity.
// - A pin changing under a run: the selection pins the version it read;
//   `readSkill` returns exactly that version, retired or superseded since,
//   while the caller may still read it.
// - Unrecorded selections: every one, a no-skill one too, is recorded by
//   the host's `onRead` port with its result and counts, never a skill's
//   text.

/** The rules a selection follows: exact matching over manifests. */
export const skillSelectionPolicyVersion = "rules@1";

/** Most readable skills one selection reads; more selects none. */
export const skillsReadMax = 100;

/** A readable skill, as a selection reads it. */
interface Candidate {
  ref: SkillRef;
  manifest: SkillManifest;
  /** The collection it is in, and whether that one is sensitive. */
  source: { id: string; sensitive: boolean };
}

/** The skill manifest in `text`'s frontmatter, with its name; none when it doesn't parse as a skill. */
const manifestOf = (
  path: string,
  text: string
): { name: string; manifest: SkillManifest } | undefined => {
  try {
    const { type, frontmatter } = parseFrontmatter(path, text);
    const manifest = skillManifestSchema.safeParse(frontmatter);
    const name: unknown = Reflect.get(frontmatter, "name");
    return type === "skill" && manifest.success && typeof name === "string"
      ? { name, manifest: manifest.data }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The skills `reader` may read, at their current versions, in a fixed
 * order; undefined past `skillsReadMax`.
 */
const readableSkills = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<{ candidates: Candidate[]; read: number } | undefined> => {
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const rows = await db
    .select({
      id: documents.id,
      path: documents.path,
      version: documents.currentVersion,
      collectionId: collections.id,
      sensitive: collections.sensitive,
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
    .where(and(eq(documents.type, "skill"), allowed.documents()))
    .orderBy(asc(collections.id), asc(documents.path))
    .limit(skillsReadMax + 1);
  if (rows.length > skillsReadMax) {
    return undefined;
  }
  const candidates: Candidate[] = [];
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- bounded by skillsReadMax, in order
    const text = await readPayload(brain, row.payload);
    const parsed = manifestOf(row.path, text);
    if (parsed !== undefined) {
      candidates.push({
        ref: {
          documentId: documentIdSchema.parse(row.id),
          collectionId: collectionIdSchema.parse(row.collectionId),
          name: parsed.name,
          version: row.version,
        },
        manifest: parsed.manifest,
        source: { id: row.collectionId, sensitive: row.sensitive },
      });
    }
  }
  return { candidates, read: rows.length };
};

/** Whether every one of `needed` is in `held`. */
const allIn = (needed: readonly string[], held: ReadonlySet<string>) =>
  needed.every((each) => held.has(each));

/**
 * Why `candidate` can't be used for the task, or undefined when it applies,
 * by the rules in order: retired, excluded, a precondition, a capability,
 * a prerequisite, a dependency.
 */
const blockedBy = (
  candidate: Candidate,
  traits: ReadonlySet<string>,
  held: ReadonlySet<string>,
  all: readonly Candidate[]
): SkillOutcome | undefined => {
  const { manifest } = candidate;
  if (manifest.status === "retired") {
    return "retired";
  }
  if (manifest.unless.some((trait) => traits.has(trait))) {
    return "excluded";
  }
  if (!allIn(manifest.when, traits)) {
    return "precondition_unmet";
  }
  if (!allIn(manifest.requires, held)) {
    return "missing_capability";
  }
  // A prerequisite: some other skill of that name, accepted, whose own
  // requirements the caller meets.
  const usable = (name: string) =>
    all.some(
      ({ ref, manifest: other }) =>
        ref.name === name &&
        ref.documentId !== candidate.ref.documentId &&
        other.status === "accepted" &&
        allIn(other.requires, held)
    );
  if (!manifest.prerequisites.every(usable)) {
    return "prerequisite_missing";
  }
  // A dependency: exactly one readable skill of that name, which has that
  // version (versions are never changed once written).
  const pinned = (dependency: string) => {
    const [name, version] = dependency.split("@");
    const named = all.filter(({ ref }) => ref.name === name);
    return (
      named.length === 1 && (named[0]?.ref.version ?? 0) >= Number(version)
    );
  };
  if (!manifest.dependencies.every(pinned)) {
    return "dependency_missing";
  }
  return undefined;
};

/** The dependencies of `candidate`, pinned at the versions it names. */
const dependenciesOf = (
  candidate: Candidate,
  all: readonly Candidate[]
): SkillRef[] =>
  candidate.manifest.dependencies.flatMap((dependency) => {
    const [name, version] = dependency.split("@");
    const found = all.find(({ ref }) => ref.name === name);
    return found === undefined
      ? []
      : [{ ...found.ref, version: Number(version) }];
  });

/**
 * Each of the skills `relevant` to the task, with why it was or wasn't
 * selected, and those left applicable once `replaces` is applied: one is
 * selected, more are each ambiguous.
 */
const outcomesOf = (
  relevant: readonly Candidate[],
  all: readonly Candidate[],
  traits: ReadonlySet<string>,
  held: ReadonlySet<string>
): { outcomes: Map<Candidate, SkillOutcome>; left: Candidate[] } => {
  const outcomes = new Map<Candidate, SkillOutcome>();
  for (const candidate of relevant) {
    const blocked = blockedBy(candidate, traits, held, all);
    if (blocked !== undefined) {
      outcomes.set(candidate, blocked);
    }
  }
  const applicable = relevant.filter((each) => !outcomes.has(each));
  // Where both apply, one that another names in `replaces` gives way.
  const replaced = new Set(
    applicable.flatMap(({ ref, manifest }) =>
      manifest.replaces.filter((name) => name !== ref.name)
    )
  );
  for (const candidate of applicable) {
    if (replaced.has(candidate.ref.name)) {
      outcomes.set(candidate, "replaced");
    }
  }
  const left = applicable.filter((each) => !outcomes.has(each));
  for (const candidate of left) {
    outcomes.set(candidate, left.length === 1 ? "selected" : "ambiguous");
  }
  return { outcomes, left };
};

/** The selection's result: the one skill left, pinned, or why none. */
const resultOf = (
  incomplete: boolean,
  left: readonly Candidate[],
  all: readonly Candidate[]
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
    : {
        kind: "skill",
        skill: chosen.ref,
        dependencies: dependenciesOf(chosen, all),
      };
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
    const readable = await readableSkills(brain, reader);
    const all = readable?.candidates ?? [];
    const relevant = all.filter(({ manifest }) =>
      manifest.tasks.includes(task.type)
    );
    const { outcomes, left } = outcomesOf(relevant, all, traits, held);
    const result = resultOf(readable === undefined, left, all);
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
          read: readable?.read ?? skillsReadMax + 1,
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

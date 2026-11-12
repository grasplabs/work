import {
  brainOf,
  currentReadMax,
  entityIdSchema,
  entityKinds,
  erasureReasons,
  identifierSchema,
  instructionsMaxLength,
  instructionsTextSchema,
  isOverInstructionsLimit,
  memoriesReadMax,
  memoryIdSchema,
  memoryTypes,
  namesPerEntityMax,
  personalBrainOf,
  principalMaxLength,
  quoteMaxLength,
  questionMaxLength,
  sourceIdMaxLength,
  statementMaxLength,
  valueMaxLength,
  wellFormedString,
  modelWaitMaxSeconds,
  storeBytesMax,
} from "@grasp-os/brain-next/contract";
import type {
  Access,
  AskModel,
  Brain,
  ErasureReason,
  Embedders,
  Entity,
  EntityId,
  Memory,
  MemoryChangeOutcome,
  MemoryId,
  ModelReply,
  Pack,
  PackItem,
  Reader,
  RecallRequest,
  SourceId,
  StepFailure,
  WayCounts,
  WorkOverview,
} from "@grasp-os/brain-next/contract";
import {
  brainReportSchema,
  brainSearchWays,
  brainSteps,
  brainWithoutMeaningReasons,
} from "@grasp-os/shared/brain-report";
import type {
  BrainAction,
  BrainActionOutcome,
  BrainReport,
  BrainSearchWay,
  BrainStep,
  BrainWithoutMeaningReason,
} from "@grasp-os/shared/brain-report";
import { firstLineOf } from "@grasp-os/shared/brain-sources";
import { isExpectedError } from "@grasp-os/shared/errors";
import { instructionFileErrors } from "@grasp-os/shared/instruction-files";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import type { ModelErrorCode } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { z } from "zod";

import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { embedInBulk, embedderModel, questionVectorOf } from "./embedder.ts";
import { modelForRole, modelSettings, models } from "./models.ts";

// The Brain, as core reaches it (@grasp-os/brain-next). The Brain knows no
// people or teams: core names them as principals, a person by their user
// ID and a team as a group (`teamGroup`). Core's other code adds, recalls
// and reads history through the functions here, naming people and teams;
// the Brain's reader is made only here, from core's own records read at
// each recall, never from what a caller claims or hands in ready-made.
//
// A source is named by the producer that adds it (one of `producerKinds`)
// and that producer's own id for it; the Brain's key for it is made only
// here (`sourceKeyOf`), so one producer can never name another's sources.
// `addSource` is a server-side function for producers: never reached by
// people, Apps or the SDK directly. People read sources only through the
// functions ending in `As` (the Brain's Sources page reaches
// `listSourcesAs`, `listVersionsAs`, `readSourceVersionAs` and `recallAs`
// through `session.brainSources`), which read as them.
//
// Every argument is checked here, strictly, before anything is named for
// the Brain: an empty or missing ID would otherwise become a principal
// ("team:", "team:undefined") the Brain can't tell from a real one, and
// a source nobody can reach would be added without a word. Every string is
// well-formed (the Brain's own rule, `wellFormedString`), so no two become
// one once encoded.

/** A team's group name starts with this; the rest is the team's ID. */
const teamPrefix = "team:";

/** A person's or a team's ID, as core passes it: never empty. */
const idSchema = wellFormedString()
  .min(1)
  .max(principalMaxLength - teamPrefix.length);

const sourceReadersSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner"), personId: idSchema }),
  z.strictObject({ kind: z.literal("team"), teamId: idSchema }),
  z.strictObject({ kind: z.literal("none") }),
]);

/** Who may read a source, as core names them. */
export type SourceReaders = z.infer<typeof sourceReadersSchema>;

/** `input` as `schema` reads it, or an error naming what was wrong. */
const checked = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Refused: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

/** The kind instruction files' keys are under (`instructionKeyOf`). */
const instructionsKind = "instructions";

/**
 * `kinds`, which must hold no ":", and never `instructionsKind`: a
 * source's key is its kind, ":", and its id, so a kind with ":" could name
 * a key under another kind, and a kind `instructions` would name the
 * instruction files' keys (read through `readSourceVersionAs`). A list
 * where one does doesn't compile.
 */
const kindsWithoutColon = <const K extends string>(
  kinds: readonly K[] &
    ([Extract<K, `${string}:${string}` | typeof instructionsKind>] extends [
      never,
    ]
      ? unknown
      : never)
): readonly K[] => kinds;

/**
 * Everything that adds sources to the Brain, one kind each. Each producer
 * issue adds its own (GRA-1727: meetings, workflow runs, interviews;
 * GRA-1730: what agents fetch). A kind is never `instructions`, the
 * instruction files' own (`instructionKeyOf`).
 *
 * A kind is only ever added, never removed or renamed: the Brain keeps
 * every key it was given, and recall reads each key's kind back
 * (`sourceRefOf`), so a kind gone from this list would fail every recall
 * whose results hold one of its sources.
 */
// `run` stays although nothing produces it now: stores filled between
// #2157 and its revert hold run sources, and a recall that meets one must
// still read it.
const producerKinds = kindsWithoutColon(["upload", "chat", "run"]);

/** Who adds a source: one of `producerKinds`. */
export type ProducerKind = (typeof producerKinds)[number];

/** The longest a kind's prefix of a source key can be. */
const longestPrefix = Math.max(...producerKinds.map((kind) => kind.length)) + 1;

/** Control characters: never part of an id or a change's key. */
const controlCharacters = /\p{Cc}/u;

/** An id or key from a producer: some characters, none of them control. */
const producerIdSchema = (most: number) =>
  wellFormedString()
    .min(1)
    .max(most)
    .refine((id) => !controlCharacters.test(id), {
      message: "Holds a control character",
    });

/**
 * A source, as its producer names it: its kind, and its own id for it.
 * The id is generated by the server (an upload's or a chat's id), never
 * taken from what a person typed.
 */
const sourceRefSchema = z.strictObject({
  producer: z.enum(producerKinds),
  id: producerIdSchema(sourceIdMaxLength - longestPrefix),
});

/** A source, as its producer names it. */
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * The Brain's key for `source`: its producer's kind first, so no producer
 * names a key under another's kind, whatever its id holds.
 */
const sourceKeyOf = ({ producer, id }: SourceRef): SourceId =>
  `${producer}:${id}`;

/** `key` as the source its producer named: the reverse of `sourceKeyOf`. */
const sourceRefOf = (key: SourceId): SourceRef => {
  const colon = key.indexOf(":");
  return checked(sourceRefSchema, {
    producer: key.slice(0, colon),
    id: key.slice(colon + 1),
  });
};

/** A change's key, from its producer: see `addSource`. */
const changeSchema = producerIdSchema(sourceIdMaxLength);

const newSourceSchema = z.strictObject({
  source: sourceRefSchema,
  change: changeSchema,
  text: wellFormedString(),
  readers: sourceReadersSchema,
});

/** A question as the Brain takes one (`recallRequestSchema`). */
const questionSchema = wellFormedString().max(questionMaxLength);

const versionRefSchema = z.strictObject({
  source: sourceRefSchema,
  version: z.int().positive(),
});

/** A version of a source, as an add answers. */
export interface SourceVersionRef {
  source: SourceRef;
  version: number;
}

/** What to recall: the question, the pack's budget, and the moment as of. */
export interface Recall {
  question: string;
  budget: { tokens: number };
  /**
   * Read each source as it was at this moment, to the millisecond and
   * including it: a version added at it counts. A caller who means "on
   * that day" passes the day's last millisecond in the time zone they
   * mean (for 14 March 2026 in Amsterdam, 2026-03-14T23:59:59.999+01:00),
   * not its midnight, which leaves out what was added that day. Each
   * source answers with its newest version added by then that still
   * exists, if the reader may read it: once a later version is erased, a
   * moment when it was current answers with the one before it. For the
   * moments a version the reader may not read was current, the source
   * answers nothing, so stepping `asOf` shows when such a version was
   * added and replaced; its existence shows in the version numbers
   * already. As of a moment, recall is by words and exact parts alone,
   * never by meaning: vectors are kept for current versions only.
   */
  asOf?: Date;
}

/** An item of a pack, citing its source as its producer named it. */
export interface RecalledItem extends Omit<PackItem, "source"> {
  source: SourceRef;
}

/** A pack, as recall answers (`recallAs`). */
export interface RecalledPack extends Omit<Pack, "items"> {
  items: RecalledItem[];
}

/** A version of a source, whole. */
export interface SourceVersion extends SourceVersionRef {
  text: string;
  addedAt: Date;
}

type BrainEnv = Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">;

/** The Brain, in its store in core's jurisdiction. */
const brain = (env: BrainEnv): Brain =>
  brainOf(inJurisdiction(env, env.BRAIN_STORE));

/**
 * A team, as the Brain's group: named by kind, so no other kind of group
 * core names later can take its name. Its ID is checked first, whether a
 * caller passed it or core's own records hold it.
 */
const teamGroup = (teamId: string): string =>
  `${teamPrefix}${checked(idSchema, teamId)}`;

const accessOf = (readers: SourceReaders): Access => {
  switch (readers.kind) {
    case "owner": {
      return { kind: "owner", person: readers.personId };
    }
    case "team": {
      return { kind: "audience", group: teamGroup(readers.teamId) };
    }
    case "none": {
      return { kind: "none" };
    }
    default: {
      throw new Error("Unknown readers");
    }
  }
};

/**
 * `personId` as the Brain's reader: the person, and the teams core counts
 * them in now. Refused once they have no current membership.
 */
const readerOf = async (
  env: Pick<Env, "DB">,
  personId: string
): Promise<Reader> => {
  const member = await memberOf(env.DB, checked(idSchema, personId));
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return {
    person: member.userId,
    groups: member.teams.map(({ id }) => teamGroup(id)),
  };
};

/**
 * Adds `text` to the Brain as a version of `source` that `readers` may
 * read; it replaces the version before in recall, which stays as history.
 *
 * `change` names this one change, unique per source: an upstream
 * revision, a message id, or an id minted before the first try. Repeat an
 * add with the same `change` (after a lost reply, at once or much later)
 * and it answers with the version it first made, whatever came since; the
 * same `change` with other text or readers is refused (which tells the
 * producer the text or readers differ from that change's: producers are
 * the server's own code). A new `change` with the same text and readers
 * as the current version is that version.
 *
 * For producers on the server only: `source.id` and `change` come from
 * the server, never from a person's input. An id is not a secret within
 * its kind (an upload's id is seen by those who can see the upload), so
 * a producer checks that whoever asks for the change may change that
 * source before it calls this; the Brain can't tell.
 */
export const addSource = async (
  env: BrainEnv,
  added: {
    source: SourceRef;
    change: string;
    text: string;
    readers: SourceReaders;
  }
): Promise<SourceVersionRef> => {
  const { source, change, text, readers } = checked(newSourceSchema, added);
  const { version } = await brain(env).addSource({
    source: sourceKeyOf(source),
    change,
    text,
    access: accessOf(readers),
  });
  return { source, version };
};

/** Whether `vector` is one the Brain takes: finite numbers, not all zero. */
const isUsableVector = (vector: readonly number[]): boolean =>
  vector.length > 0 &&
  vector.every((value) => Number.isFinite(value)) &&
  vector.some((value) => value !== 0);

/**
 * `question`'s vector by core's question embedder, for the Brain to
 * search by meaning too; none while no model ships, for a question of
 * whitespace (which words a question holds is the Brain's to say, so a
 * question of punctuation alone is still embedded, and the Brain finds
 * nothing for it), or when the embedder gave no vector the Brain can use
 * in time: then why, logged with nothing of the question or the person,
 * and handed to the Brain, which counts it for staff; recall goes ahead
 * by words and exact parts. With no model shipped there is no why: going
 * without is no failure then.
 */
const meaningOf = async (
  env: Pick<Env, "EMBEDDER" | "DURABLE_OBJECT_JURISDICTION">,
  question: string
): Promise<Pick<RecallRequest, "meaning" | "withoutMeaning">> => {
  if (question.trim() === "") {
    return {};
  }
  const embedded = await questionVectorOf(env, question);
  if (embedded === null) {
    return {};
  }
  if (embedded.kind === "vector" && isUsableVector(embedded.vector)) {
    return { meaning: { model: embedded.model, vector: embedded.vector } };
  }
  const reason = embedded.kind === "none" ? embedded.reason : "unusable";
  log.warn("brain.recall.without_meaning", { reason });
  return { withoutMeaning: reason };
};

/**
 * A pack of what the member `personId` may read for `question`, as core
 * counts them now, within `budget.tokens` (the Brain's estimate,
 * `tokensOf`), and, with `asOf`, of each source as it was then: the
 * Brain's `recall`, by words, exact parts and, once a model ships, by
 * meaning: the question is embedded while its reader is read. Every item
 * cites its source, version and place; the pack says what was not found
 * and whether the budget cut it short, all from what they may read alone.
 * Refused once they are no longer a member, or when `personId` isn't an
 * ID.
 */
export const recallAs = async (
  env: BrainEnv & Pick<Env, "DB" | "EMBEDDER">,
  personId: string,
  { question: asked, budget, asOf }: Recall
): Promise<RecalledPack> => {
  // As the Brain checks it, before the embedder sees any of it.
  const question = checked(questionSchema, asked);
  const [reader, meaning] = await Promise.all([
    readerOf(env, personId),
    // As of a moment the Brain never searches by meaning: nothing to embed.
    asOf === undefined ? meaningOf(env, question) : {},
  ]);
  const { items, notFound, truncated } = await brain(env).recall({
    question,
    reader,
    budget,
    ...(asOf === undefined ? {} : { asOf }),
    ...meaning,
  });
  return {
    items: items.map(({ source, version, position, text, whole, found }) => ({
      source: sourceRefOf(source),
      version,
      position,
      text,
      whole,
      found,
    })),
    notFound,
    truncated,
  };
};

/**
 * Version `version` of `source`, current or history, whole, for the
 * member `personId`: only if they are among that version's readers and
 * the current version's, so narrowing a source's readers hides its
 * history from those taken off. Both are read with the teams core counts
 * them in now: someone who joins a team reads the history that team
 * could read from before they joined. `null` when there is none or they
 * may not, alike. Refused once they are no longer a member. For the
 * server only, as `addSource`.
 */
export const readSourceVersionAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: { source: SourceRef; version: number }
): Promise<SourceVersion | null> => {
  const { source, version } = checked(versionRefSchema, wanted);
  const read = await brain(env).readVersion({
    source: sourceKeyOf(source),
    version,
    reader: await readerOf(env, personId),
  });
  return read === null
    ? null
    : { source, version, text: read.text, addedAt: read.addedAt };
};

/** Where a page of a listing starts: after this source, as its producer named it. */
export interface SourcesAfter {
  addedAt: Date;
  source: SourceRef;
}

const sourcesAfterSchema = z.strictObject({
  addedAt: z.date(),
  source: sourceRefSchema,
});

/**
 * A source, as a listing names it: its current version, when that was
 * added, its first line (of its first passage, as its text gives it, for
 * a title: empty when that passage opens with no line of text), whether
 * it is the reader's alone (nobody else may read it, admins included),
 * and how many of its versions the reader may read.
 */
export interface ListedSource {
  source: SourceRef;
  version: number;
  addedAt: Date;
  firstLine: string;
  personal: boolean;
  versions: number;
}

/** A page of sources, and where the next one starts: null at the last. */
export interface SourcePage {
  sources: ListedSource[];
  next: SourcesAfter | null;
}

/**
 * A page of the sources the member `personId` may read, of every
 * producer's kind (never an instruction file), newest first by when their
 * current version was added, after `after` when given: what they may not
 * read takes no place in it. Refused once they are no longer a member.
 */
export const listSourcesAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  { after }: { after?: SourcesAfter } = {}
): Promise<SourcePage> => {
  const from =
    after === undefined ? undefined : checked(sourcesAfterSchema, after);
  const { sources, more } = await brain(env).listSources({
    reader: await readerOf(env, personId),
    prefixes: producerKinds.map((kind) => `${kind}:`),
    ...(from === undefined
      ? {}
      : { after: { addedAt: from.addedAt, source: sourceKeyOf(from.source) } }),
  });
  const listed = sources.map(
    ({
      source,
      version,
      addedAt,
      opening,
      personal,
      versions,
    }): ListedSource => ({
      source: sourceRefOf(source),
      version,
      addedAt,
      firstLine: firstLineOf(opening),
      personal,
      versions,
    })
  );
  const last = listed.at(-1);
  return {
    sources: listed,
    next:
      more && last !== undefined
        ? { addedAt: last.addedAt, source: last.source }
        : null,
  };
};

/** A version of a source, as a listing names it. */
export interface ListedVersion {
  version: number;
  addedAt: Date;
}

/** A page of versions, and the version the next one starts below: null at the last. */
export interface VersionPage {
  versions: ListedVersion[];
  before: number | null;
}

const versionsWantedSchema = z.strictObject({
  source: sourceRefSchema,
  before: z.int().positive().optional(),
});

/**
 * A page of the versions of `source` the member `personId` may read,
 * newest first, below `before` when given: only while they may read its
 * current version, as `readSourceVersionAs` reads them; none, alike, for
 * a source there isn't. Refused once they are no longer a member.
 */
export const listVersionsAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: { source: SourceRef; before?: number }
): Promise<VersionPage> => {
  const { source, before } = checked(versionsWantedSchema, wanted);
  const { versions, more } = await brain(env).listVersions({
    source: sourceKeyOf(source),
    reader: await readerOf(env, personId),
    ...(before === undefined ? {} : { before }),
  });
  const last = versions.at(-1);
  return {
    versions: versions.map(({ version, addedAt }) => ({ version, addedAt })),
    before: more && last !== undefined ? last.version : null,
  };
};

// Erasure: for good, apart from ordinary removal, where a new version
// keeps the one before as history. Each erasure is in the Brain's ledger
// before it returns, and nothing it covers is found or read from then on;
// the Brain deletes the rest on core's clock, its files included once no
// version holds them, and erases it again after a restore of its store.
// For core's server code only, once whoever asks may erase it: neither
// function checks, and both answer alike whatever there was to erase.

const sourceErasureSchema = z.strictObject({
  source: sourceRefSchema,
  reason: z.enum(erasureReasons),
});

const personErasureSchema = z.strictObject({
  personId: idSchema,
  reason: z.enum(erasureReasons),
});

/**
 * Erases `source` for good: every version, with everything kept of it.
 * Its key is closed: a later add of it is refused, so a producer's late
 * retry never brings it back. Safe to repeat. For a producer's deletion
 * for good, or the end of its retention.
 *
 * Only a call that returned is in the Brain's ledger. A call that fails
 * or throws must be retried until it succeeds: until then, a restore of
 * the Brain's store can bring the source back.
 */
export const eraseSource = async (
  env: BrainEnv,
  erased: { source: SourceRef; reason: ErasureReason }
): Promise<void> => {
  const { source, reason } = checked(sourceErasureSchema, erased);
  await brain(env).eraseSource({ source: sourceKeyOf(source), reason });
};

/**
 * Erases what only `personId` may read, added up to now: their own
 * sources' every version (their uploads, chats and runs, their
 * instruction file), and, in a source others read now, the versions that
 * were theirs alone. Content added for them later is new. Safe to repeat.
 * For an admin's erasure of a person, or a person's withdrawal.
 *
 * Only a call that returned is in the Brain's ledger. A call that fails
 * or throws must be retried until it succeeds: until then, a restore of
 * the Brain's store can bring what it covers back.
 */
export const erasePerson = async (
  env: BrainEnv,
  erased: { personId: string; reason: ErasureReason }
): Promise<void> => {
  const { personId, reason } = checked(personErasureSchema, erased);
  await brain(env).erasePerson({ person: personId, reason });
};

// Instruction files: what people write for every chat to start with (the
// company's instructions and lasting facts, a person's own file, an App's
// and an agent's), each a source of its own under `instructions:`, kept
// whole and versioned, never indexed, so recall never returns one. Who
// may read each in the Brain: a person's file, that person; an App's, the
// App's group, which core puts in a reader only once they passed the
// builder check; the company's and agents', the company. Which of them
// reaches which chat or run, and who may write each, is
// instruction-files.ts's rule; the functions here only name them for the
// Brain.

/** Every current member is in this group, and in no other way. */
const companyGroup = "company";

/** An App's group: only for a reader who builds the App. */
const appGroup = (appId: string): string => `app:${appId}`;

/** The longest prefix of an instruction file's key. */
const instructionKeyPrefixMax = `${instructionsKind}:person:`.length;

/**
 * The ID in an instruction file's key: never empty, no control
 * characters, the key in bounds.
 */
const instructionIdSchema = producerIdSchema(
  sourceIdMaxLength - instructionKeyPrefixMax
);

/**
 * An instruction file, by its scope: one of the company's two (its
 * instructions, and its lasting facts), one person's, one App's or one
 * agent's.
 */
const instructionFileSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("company"),
    name: z.enum(["instructions", "facts"]),
  }),
  z.strictObject({
    scope: z.literal("person"),
    personId: idSchema.pipe(instructionIdSchema),
  }),
  z.strictObject({ scope: z.literal("app"), appId: instructionIdSchema }),
  z.strictObject({ scope: z.literal("agent"), agentId: instructionIdSchema }),
]);

/** An instruction file, by its scope. */
export type InstructionFile = z.infer<typeof instructionFileSchema>;

/**
 * `input` as an instruction file, checked whole: refused with
 * `permission.invalid` when it isn't one. For instruction-files.ts, which
 * checks who may write a file before it is added.
 */
export const instructionFileOf = (input: unknown): InstructionFile =>
  permissionErrors.parse("permission.invalid", instructionFileSchema, input);

/** The Brain's key for `file`: its scope is part of it. */
const instructionKeyOf = (file: InstructionFile): SourceId => {
  switch (file.scope) {
    case "company": {
      return `${instructionsKind}:company:${file.name}`;
    }
    case "person": {
      return `${instructionsKind}:person:${file.personId}`;
    }
    case "app": {
      return `${instructionsKind}:app:${file.appId}`;
    }
    case "agent": {
      return `${instructionsKind}:agent:${file.agentId}`;
    }
    default: {
      throw new Error("Unknown instruction file");
    }
  }
};

/** Who may read `file` in the Brain (above). */
const instructionAccessOf = (file: InstructionFile): Access => {
  switch (file.scope) {
    case "person": {
      return { kind: "owner", person: file.personId };
    }
    case "app": {
      return { kind: "audience", group: appGroup(file.appId) };
    }
    case "company":
    case "agent": {
      return { kind: "audience", group: companyGroup };
    }
    default: {
      throw new Error("Unknown instruction file");
    }
  }
};

const newInstructionsSchema = z.strictObject({
  file: instructionFileSchema,
  change: changeSchema,
  text: instructionsTextSchema,
});

/** A version of an instruction file, whole. */
export interface InstructionFileVersion {
  file: InstructionFile;
  version: number;
  text: string;
  addedAt: Date;
}

/**
 * Adds `text` as the next version of the instruction file `file`; the one
 * before stays as history. Refused over `instructionsMaxLength` UTF-16
 * units with `instructions.too_large`, and with no text. `change` is as
 * `addSource`'s.
 *
 * For instruction-files.ts only, which checks who may write `file` first:
 * nothing here does.
 */
export const addInstructionFile = async (
  env: BrainEnv,
  added: { file: InstructionFile; change: string; text: string }
): Promise<{ file: InstructionFile; version: number }> => {
  if (typeof added.text === "string" && isOverInstructionsLimit(added.text)) {
    throw instructionFileErrors.create("instructions.too_large", {
      maxLength: instructionsMaxLength,
    });
  }
  const { file, change } = checked(newInstructionsSchema, added);
  const { version } = await brain(env).addInstructions({
    source: instructionKeyOf(file),
    change,
    text: added.text,
    access: instructionAccessOf(file),
  });
  return { file, version };
};

const instructionFilesSchema = z
  .array(instructionFileSchema)
  .max(currentReadMax);

/**
 * The current version of each of `wanted` that `member` may read, whole,
 * in the order given: their own file, the company's and agents', and the
 * App `builtApp`'s, never another person's or another App's. A file never
 * written is left out.
 *
 * For instruction-files.ts only, which picks the files a context gets,
 * reads `member` from core's records, and passes `builtApp` only once
 * they passed its builder check: both are taken here on the caller's
 * word, so no other code may call it. (Exported only because core's
 * Brain contract is reachable from this file alone.)
 */
export const readInstructionFilesAs = async (
  env: BrainEnv,
  member: Pick<Member, "userId">,
  wanted: InstructionFile[],
  builtApp?: string
): Promise<InstructionFileVersion[]> => {
  const files = checked(instructionFilesSchema, wanted);
  // An instruction file is never a team's, so its reader is the person,
  // the company and the App they build, if any.
  const groups =
    builtApp === undefined
      ? [companyGroup]
      : [companyGroup, appGroup(checked(instructionIdSchema, builtApp))];
  const byKey = new Map(files.map((file) => [instructionKeyOf(file), file]));
  const read = await brain(env).readCurrent({
    sources: [...byKey.keys()],
    reader: { person: checked(idSchema, member.userId), groups },
  });
  return read.flatMap(({ source, version, text, addedAt }) => {
    const file = byKey.get(source);
    return file === undefined ? [] : [{ file, version, text, addedAt }];
  });
};

/**
 * The gateway's refusals of a call as it is: the item's own failure. Every
 * other failure is of the way to a model, which the whole queue waits out.
 * `model.request_refused` is a provider refusing the request itself (a
 * 4xx other than its key, credit or rate: a bad request, a prompt too
 * long, a content policy), on any key. `model.failed` is not the item's:
 * on Grasp's key it is any failure of the provider, and it is connect
 * out of reach.
 */
const itemRefusals: ReadonlySet<string> = new Set<ModelErrorCode>([
  "model.invalid_call",
  "model.answer_too_long",
  "model.invalid_output",
  "model.request_refused",
]);

/**
 * The gateway's failures that need someone at the AI account: no model
 * set up or allowed, a key refused or revoked. Out of credit comes as a
 * rate limit with no wait to keep (`waitOf`).
 */
const accountTroubles: ReadonlySet<string> = new Set<ModelErrorCode>([
  "model.no_provider",
  "model.unconfigured",
  "model.not_allowed",
  "model.provider_key_failed",
  // Grasp's AI used up for the month: until the next month, or the
  // organization's own key.
  "model.grasp_limit_reached",
]);

/**
 * Room past the call's own time for the gateway's deadline: the call's
 * signal ends it first, so a call cut off is never taken for anything
 * else.
 */
const gatewayGraceMs = 5000;

/** What `error` of the gateway asks the queue to wait for, and why. */
const waitOf = (error: unknown): ModelReply => {
  const code = modelErrors.codeOf(error);
  if (code !== undefined && accountTroubles.has(code)) {
    return { kind: "busy", reason: "account" };
  }
  if (code !== "model.rate_limited") {
    return { kind: "busy", reason: "unavailable" };
  }
  const wait = isExpectedError(error)
    ? error.details?.retryAfterSeconds
    : undefined;
  // A rate limit names its wait; an account out of credit names none.
  return typeof wait === "number" && wait > 0
    ? {
        kind: "busy",
        reason: "rate_limited",
        retryAfterSeconds: Math.min(wait, modelWaitMaxSeconds),
      }
    : { kind: "busy", reason: "account" };
};

/**
 * The Brain's background work asking a model, through core's gateway like
 * every model call: the organization's model and key, judged as core's own
 * upkeep of the Brain (`brain_upkeep`), metered and audited, and cancelled
 * once the time the queue gave it is up (`timed_out`). One call is one
 * request: when the provider limits calls or the way to a model fails, the
 * gateway doesn't wait and retry; the whole queue pauses instead (`busy`).
 * The gateway's refusal of the call as it is fails the item (`refused`):
 * no provider's or gateway's words reach the Brain.
 */
const askModel =
  (env: Env): AskModel =>
  async ({ purpose, system, input, timeoutMs }) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const { text } = await models(env).call({
        model: modelForRole(await modelSettings(env), "careful"),
        system,
        input,
        purpose,
        trigger: { type: "system" },
        work: { platform: "brain_upkeep" },
        providerRetries: false,
        timeoutMs: timeoutMs + gatewayGraceMs,
        signal,
      });
      return { kind: "answer", text };
    } catch (error) {
      if (signal.aborted) {
        // No answer within the call's time, which is the item's: its own.
        return { kind: "timed_out" };
      }
      const code = modelErrors.codeOf(error);
      if (code !== undefined && itemRefusals.has(code)) {
        return { kind: "refused" };
      }
      return waitOf(error);
    }
  };

/**
 * Core's embedders, as the Brain's background work uses them: the bulk
 * embedders, running the model core ships, or none while none ships (then
 * the Brain embeds nothing, and its overview says so). Whatever an
 * embedder answers or throws, the Brain gets vectors or `unavailable`.
 */
const embeddersOf = async (env: Env): Promise<Embedders> => ({
  model: await embedderModel(),
  embed: async ({ texts, timeoutMs }) =>
    await embedInBulk(env, texts, timeoutMs),
});

/**
 * One tick of the Brain's background work at `at`, the time core's clock
 * runs it: the store sweeps what adds that never finished left, repacks a
 * few blocks of vector codes, keeps its vectors to core's embedding model,
 * then runs what is due in its queue, its model calls through core's
 * gateway and its passages through core's bulk embedders. Harmless late or
 * twice.
 */
export const workBrain = async (env: Env, at: Date): Promise<void> => {
  await brain(env).work(askModel(env), at, await embeddersOf(env));
};

/** The Brain's work queue, store and ledger, as staff see it (brain-report.ts). */
export const brainWorkOverview = async (env: BrainEnv): Promise<WorkOverview> =>
  await brain(env).workOverview();

/**
 * The names the store keys something by, when the report names the same
 * ones: a name either has and the other doesn't makes this `never`, so
 * the report's list fails to compile and none is dropped silently.
 */
type SameNames<Store extends string, Report extends string> = [Store] extends [
  Report,
]
  ? [Report] extends [Store]
    ? readonly Store[]
    : never
  : never;

/** Every step the store names, in the tick's order. */
const reportedSteps = brainSteps satisfies SameNames<
  keyof WorkOverview["stepsFailed"],
  BrainStep
>;

/** Every way of recall the store counts. */
const reportedWays = brainSearchWays satisfies SameNames<
  keyof WorkOverview["recall"]["ways"],
  BrainSearchWay
>;

/** Every reason the store counts a recall without meaning by. */
const reportedReasons = brainWithoutMeaningReasons satisfies SameNames<
  keyof WorkOverview["recall"]["withoutMeaning"],
  BrainWithoutMeaningReason
>;

/** A step's last failure as the staff report says it. */
const failureOf = (
  failure: StepFailure | null
): BrainReport["stepsFailed"]["ledger"] =>
  failure === null
    ? null
    : { at: failure.at.toISOString(), reason: failure.reason };

/** Each of the store's steps' last failure, as the report says it: a code and a time. */
const stepsFailedOf = (
  steps: WorkOverview["stepsFailed"]
): BrainReport["stepsFailed"] =>
  brainReportSchema.shape.stepsFailed.parse(
    Object.fromEntries(
      reportedSteps.map((step) => [step, failureOf(steps[step])])
    )
  );

/** A way's counts as the report says them, field by field. */
const wayOf = ({ recalls, failed }: WayCounts) => ({ recalls, failed });

/** Recall by each way and without meaning, as the report says it: counts. */
const recallOf = (recall: WorkOverview["recall"]): BrainReport["recall"] =>
  brainReportSchema.shape.recall.parse({
    since: recall.since.toISOString(),
    ways: Object.fromEntries(
      reportedWays.map((way) => [way, wayOf(recall.ways[way])])
    ),
    withoutMeaning: Object.fromEntries(
      reportedReasons.map((reason) => [reason, recall.withoutMeaning[reason]])
    ),
  });

/**
 * The Brain as Grasp's staff see it (brain-report.ts): its overview, field
 * by field, operational state only. What names anything is left out: a
 * work item's key and an overdue item's key (a source's key, say).
 * Erasures are counts alone: never which, when, or by what hash.
 */
export const brainStaffReport = async (env: BrainEnv): Promise<BrainReport> => {
  const overview = await brain(env).workOverview();
  return {
    now: new Date().toISOString(),
    queue: {
      waiting: overview.waiting.map(({ kind, count, oldestAddedAt }) => ({
        kind,
        count,
        oldestAddedAt: oldestAddedAt.toISOString(),
      })),
      running: overview.running,
      overdue: overview.overdue.length,
      paused:
        overview.paused === null
          ? null
          : {
              reason: overview.paused.reason,
              since: overview.paused.since.toISOString(),
              until: overview.paused.until.toISOString(),
            },
      parked: overview.parked.map((parked) => ({
        item: parked.id,
        kind: parked.kind,
        attempts: parked.attempts,
        parks: parked.parks,
        final: parked.final,
        error: parked.error,
        message: parked.message,
        parkedAt: parked.parkedAt.toISOString(),
      })),
      parkedCount: overview.parkedCount,
    },
    store: { bytes: overview.storeBytes, limitBytes: storeBytesMax },
    words: overview.words,
    embedding: {
      model: overview.embedding.model,
      chunks: overview.embedding.chunks,
      embedded: overview.embedding.embedded,
      passedOver: overview.embedding.unembeddable,
      rebuilding:
        overview.embedding.model !== null && !overview.embedding.rebuilt,
    },
    ledger: {
      replay: overview.ledgerReplay,
      erasing: overview.erasing,
      sourcesWithoutCurrent: overview.sourcesWithoutCurrent,
      source: overview.erasures.source,
      person: overview.erasures.person,
      byReason: overview.erasures.byReason,
    },
    stepsFailed: stepsFailedOf(overview.stepsFailed),
    recall: recallOf(overview.recall),
  };
};

/**
 * What Grasp's staff asked of the Brain (brain-report.ts), done: a parked
 * item put back in the queue, a rebuild of the word indexes started, or
 * the embedding's rebuild started again (a re-embed).
 * `nothing` when no item of that id is parked or a rebuild is under way;
 * `unavailable` while the store reads its erasure ledger: the store's own
 * gate refuses it, applying nothing.
 */
export const actOnBrainForStaff = async (
  env: BrainEnv,
  action: BrainAction
): Promise<BrainActionOutcome> => {
  switch (action.type) {
    case "requeue": {
      return await brain(env).requeueWork(action.item);
    }
    case "rebuild_words": {
      return await brain(env).rebuildWords();
    }
    case "reembed": {
      return await brain(env).reembed();
    }
    default: {
      // A new kind of action fails to compile until it is handled here;
      // what came anyway is never echoed.
      const unhandled: never = action;
      throw new Error(`No such action (${typeof unhandled})`);
    }
  }
};

// Memories and entities, for a person core verified (GRA-1743): what
// `brain-memories.ts` writes and reads for a chat, an App or a run acting
// for them. Everything written here is readable by that person alone and
// kept in their own store (`person:<id>`), never in the shared one: the
// plan's rule is that a memory an agent writes is readable only by those
// who can read everything its chat or run read, and never by more than
// the chat's or App's own users. A person's own chat read what they may
// read; an App's or workflow's run reads from several teams' content, App
// data and connections, whose readers have no one set core can name, so
// the plan's fallback holds for both: the person alone. Widening a memory
// is a person's act of its own (the plan's "publish"), not built here.
//
// Reads take `personal` from core, never from a caller's input: only a
// person's own chat reads their own store (as recall's `personal` does),
// so what is theirs alone never reaches App data. Every read asks each
// store as the same reader, which filters inside its own statements, and
// joins the answers, the shared store's first: neither answer depends on
// the other store's hidden rows.

/** `person`'s own store, where what only they may read is kept. */
const personsOwn = (env: BrainEnv, person: string): Brain =>
  personalBrainOf(inJurisdiction(env, env.BRAIN_STORE), person);

/** The stores a read for `person` asks: the shared one, and theirs when `personal`. */
const storesFor = (env: BrainEnv, person: string, personal: boolean) =>
  personal ? [brain(env), personsOwn(env, person)] : [brain(env)];

/** A short text of a memory: some text, at most `max` characters. */
const memoryText = (max: number) => wellFormedString().regex(/\S/u).max(max);

/**
 * An agent writing for a person, as core names it: a kind, ":", and its
 * id (`app:<id>`, `run:<id>`), so it is never a person's ID.
 */
const agentWriterSchema = wellFormedString()
  .max(principalMaxLength)
  .regex(/^[a-z]+:\S+$/u);

/**
 * Whose word a memory is: the person's own (`own`), said by them and
 * saved for them, or an agent's acting for them (an App, a run), which is
 * never a preference or an instruction (the Brain refuses one).
 */
const memoryWordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("own") }),
  z.strictObject({ kind: z.literal("agent"), agent: agentWriterSchema }),
]);
export type MemoryWord = z.infer<typeof memoryWordSchema>;

/**
 * What a memory is about: an entity by its id in the person's own store,
 * or by its kind and the names and exact identifiers given, linked to one
 * the store holds on an identifier alone.
 */
const memoryAboutSchema = z.strictObject({
  id: entityIdSchema.optional(),
  kind: z.enum(entityKinds),
  names: z.array(memoryText(valueMaxLength)).max(namesPerEntityMax).default([]),
  identifiers: z.array(identifierSchema).max(namesPerEntityMax).default([]),
});

const attributeSchema = wellFormedString().min(1).max(64);

const rememberedSchema = z.strictObject({
  change: changeSchema,
  about: memoryAboutSchema,
  attribute: attributeSchema.optional(),
  value: memoryText(valueMaxLength).optional(),
  type: z.enum(memoryTypes),
  statement: memoryText(statementMaxLength),
  quote: memoryText(quoteMaxLength).optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
});

/** A memory to save for a person (`rememberAs`), as its schema takes it. */
export type Remembered = z.input<typeof rememberedSchema>;

/** What `rememberAs` saved: the memory, and the entity it is about. */
export interface RememberedMemory {
  memory: MemoryId;
  entity: EntityId;
}

/** The writer and the speaker a memory of `word` for `person` records. */
const writerOf = (person: string, word: MemoryWord) =>
  word.kind === "own"
    ? { writer: person, speaker: { kind: "internal" as const, person } }
    : {
        writer: word.agent,
        speaker: { kind: "agent" as const, agent: word.agent },
      };

/**
 * Saves a memory for the member `personId` in `said` (whose word it is,
 * which core sets), readable by them alone, in
 * their own store: about an entity of theirs (by id), or one found by an
 * exact identifier there, or a new one. The same writer saying something
 * new of the same entity and one-value attribute ends their earlier
 * memory, which stays as history. `change` names this one save, minted by
 * core (a chat's tool call, a run's step): the same change again answers
 * what it saved. Refused once they are no longer a member, and by the
 * Brain for what its rules refuse (a preference or instruction that isn't
 * their own word, an attribute their entity's kind doesn't have).
 */
export const rememberAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  said: MemoryWord,
  remembered: Remembered | Readonly<Record<string, unknown>>
): Promise<RememberedMemory> => {
  const word = checked(memoryWordSchema, said);
  const { change, about, quote, ...memory } = checked(
    rememberedSchema,
    remembered
  );
  const { person } = await readerOf(env, personId);
  const { writer, speaker } = writerOf(person, word);
  const added = await personsOwn(env, person).addMemories({
    change,
    access: { kind: "owner", person },
    entities: [{ key: "about", ...about }],
    memories: [
      {
        about: "about",
        ...memory,
        speaker,
        basis: {
          kind: "writer",
          writer,
          ...(quote === undefined ? {} : { quote }),
        },
      },
    ],
  });
  const [saved] = added.memories;
  const entity = added.entities.about;
  if (saved === undefined || entity === undefined) {
    throw new Error("The Brain saved no memory");
  }
  return { memory: saved, entity };
};

const forgottenSchema = z.strictObject({
  memory: memoryIdSchema,
  word: memoryWordSchema,
});

/**
 * Retires one of the memories `word` saved for the member `personId`
 * (`rememberAs`): it stops being current, and stays as history. `nothing`
 * alike when there is no such memory, when another writer's it is, and
 * when it was no longer current. Refused once they are no longer a member.
 */
export const forgetAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  forgotten: { memory: string; word: MemoryWord }
): Promise<MemoryChangeOutcome> => {
  const { memory, word } = checked(forgottenSchema, forgotten);
  const { person } = await readerOf(env, personId);
  return await personsOwn(env, person).retireMemory({
    memory,
    writer: writerOf(person, word).writer,
  });
};

const correctionSchema = z.strictObject({
  memory: memoryIdSchema,
  entity: entityIdSchema,
  attribute: attributeSchema.optional(),
  fix: z
    .strictObject({
      change: changeSchema,
      statement: memoryText(statementMaxLength),
      value: memoryText(valueMaxLength).optional(),
      quote: memoryText(quoteMaxLength).optional(),
    })
    .optional(),
});

/** A correction (`correctAs`). */
export type Correction = z.input<typeof correctionSchema>;

/**
 * The member `personId` says a memory about `entity` is right, or wrong
 * with a fix, in their own word. Without a fix, the memory is confirmed
 * where it is kept: read first among those it was confirmed over. With
 * one, the fix is saved as their memory of the same entity, attribute and
 * type, readable by them alone, and confirmed: it ends their own earlier
 * memory, and is read before any other writer's. Answers the memory
 * confirmed, or null alike when they may not read one of that id (of
 * `attribute`, when given), it is no longer current, or the fix can't be
 * kept: a fix is filed in their own store, so only for a memory kept
 * there (the Brain's shared store can't yet file a fix under the readers
 * of the memory it corrects), and never for a relation. Reads their own
 * store only when `personal`.
 */
export const correctAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  correction: Correction,
  { personal }: { personal: boolean }
): Promise<MemoryId | null> => {
  const { memory, entity, attribute, fix } = checked(
    correctionSchema,
    correction
  );
  const reader = await readerOf(env, personId);
  if (fix === undefined) {
    for (const store of storesFor(env, reader.person, personal)) {
      // One store holds a memory of this id: the next is asked only when
      // this one confirmed nothing.
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      if ((await store.confirmMemory({ memory, reader })) === "done") {
        return memory;
      }
    }
    return null;
  }
  if (!personal) {
    return null;
  }
  const own = personsOwn(env, reader.person);
  const [{ memories }, about] = await Promise.all([
    own.readMemories({
      entity,
      reader,
      ...(attribute === undefined ? {} : { attribute }),
      limit: memoriesReadMax,
    }),
    own.readEntity({ entity, reader }),
  ]);
  const corrected = memories.find(({ id }) => id === memory);
  if (corrected === undefined || about === null || corrected.object !== null) {
    return null;
  }
  const { writer, speaker } = writerOf(reader.person, { kind: "own" });
  const added = await own.addMemories({
    change: fix.change,
    access: { kind: "owner", person: reader.person },
    entities: [{ key: "about", id: about.id, kind: about.kind }],
    memories: [
      {
        about: "about",
        ...(corrected.attribute === null
          ? {}
          : { attribute: corrected.attribute }),
        ...(fix.value === undefined ? {} : { value: fix.value }),
        type: corrected.type,
        statement: fix.statement,
        speaker,
        basis: {
          kind: "writer",
          writer,
          ...(fix.quote === undefined ? {} : { quote: fix.quote }),
        },
      },
    ],
  });
  const [saved] = added.memories;
  if (saved === undefined) {
    return null;
  }
  // A retry with the same change answers the same fix, and confirms it
  // again: only a confirmation that took counts as corrected.
  return (await own.confirmMemory({ memory: saved, reader })) === "done"
    ? saved
    : null;
};

/** A memory as a person reads it: its source as its producer named it. */
export interface ReadMemory extends Omit<Memory, "source"> {
  /**
   * The source version it rests on; null for a writer's, and for one
   * drawn from what no producer adds (an instruction file).
   */
  source: SourceVersionRef | null;
}

/** An entity as a person reads it, with the current memories about it they may read. */
export interface EntityCard {
  entity: Entity;
  memories: ReadMemory[];
}

/** `memory` as a person reads it (`ReadMemory`). */
const readMemoryOf = ({ source, ...memory }: Memory): ReadMemory => {
  if (source === null) {
    return { ...memory, source: null };
  }
  const colon = source.source.indexOf(":");
  const ref = sourceRefSchema.safeParse({
    producer: source.source.slice(0, colon),
    id: source.source.slice(colon + 1),
  });
  return {
    ...memory,
    source: ref.success ? { source: ref.data, version: source.version } : null,
  };
};

/**
 * The entity `entity`, with the current memories about it, as the member
 * `personId` may read them: from the shared store, or, when `personal`,
 * their own, which holds it when the shared one doesn't (an entity's id is
 * its store's own). Null alike when there is none or they may not.
 * Refused once they are no longer a member.
 */
export const entityAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  entity: string,
  { personal }: { personal: boolean }
): Promise<EntityCard | null> => {
  const id = checked(entityIdSchema, entity);
  const reader = await readerOf(env, personId);
  for (const store of storesFor(env, reader.person, personal)) {
    // oxlint-disable-next-line no-await-in-loop -- one store at a time
    const [read, { memories }] = await Promise.all([
      store.readEntity({ entity: id, reader }),
      store.readMemories({ entity: id, reader, limit: memoriesReadMax }),
    ]);
    if (read !== null) {
      return { entity: read, memories: memories.map(readMemoryOf) };
    }
  }
  return null;
};

const entitiesWantedSchema = z
  .strictObject({
    kind: z.enum(entityKinds).optional(),
    identifier: identifierSchema.optional(),
    name: memoryText(valueMaxLength).optional(),
    limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
  })
  .refine(
    ({ kind, identifier, name }) =>
      kind !== undefined || identifier !== undefined || name !== undefined,
    { message: "Names no kind, identifier or name" }
  );

/** What entities to find (`findEntitiesAs`): at least one of a kind, an identifier or a name. */
export type EntitiesWanted = z.input<typeof entitiesWantedSchema>;

/**
 * The entities the member `personId` may see that match: of a kind,
 * holding an exact identifier, or a name (whole, without case), at most
 * `limit`; the shared store's first, each store's in its own order, then,
 * when `personal`, their own's. Refused once they are no longer a member.
 */
export const findEntitiesAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: EntitiesWanted,
  { personal }: { personal: boolean }
): Promise<Entity[]> => {
  const request = checked(entitiesWantedSchema, wanted);
  const reader = await readerOf(env, personId);
  const found = await Promise.all(
    storesFor(env, reader.person, personal).map(
      async (store) => await store.findEntities({ ...request, reader })
    )
  );
  return found.flat().slice(0, request.limit);
};

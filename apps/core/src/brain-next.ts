import { packAcross, sourcesAcross } from "@grasp-os/brain-next/across";
import {
  brainOf,
  contestedCursorSchema,
  currentReadMax,
  entitiesCursorSchema,
  entityAttributes,
  entityIdSchema,
  entityKinds,
  fitsSourceText,
  erasedSource,
  changeReused,
  listPageMax,
  erasureReasons,
  exportFileNameSchema,
  exportIdSchema,
  handOversMax,
  identifierSchema,
  instructionsMaxLength,
  instructionsTextSchema,
  isOverInstructionsLimit,
  memoriesCursorSchema,
  memoryIdSchema,
  memoryTypes,
  namesPerEntityMax,
  isStillDeleting,
  principalMaxLength,
  quoteMaxLength,
  questionMaxLength,
  readableCheckMax,
  recallRequestSchema,
  sourceIdMaxLength,
  staleVersion,
  statementMaxLength,
  valueMaxLength,
  storeErased,
  wellFormedString,
  modelWaitMaxSeconds,
  modelRoles as brainModelRoles,
  packItemTokens,
  refusalPrefix,
  restoringNow,
  personalBrainOf,
  stillDeletingAtMostMs,
  storeBytesMax,
  workPriorities,
  storeKindOf,
} from "@grasp-os/brain-next/contract";
import type {
  Access,
  AskModel,
  AttributeRule,
  Brain,
  ContestedCursor,
  Entity,
  EntitiesCursor,
  ErasureReason,
  Embedders,
  EntityKind,
  EntityNamesCursor,
  Identifier,
  EntityId,
  Memory,
  MemoriesCursor,
  MemoryChangeOutcome,
  MemoryId,
  ExportStatus,
  Finding,
  KeyState,
  HandOverPriority,
  HandOverRequest,
  HandOverResult,
  HandOvers,
  ModelReply,
  Pack,
  PackItem,
  PackMemory,
  PersonReader,
  Reader,
  RecallRequest,
  RestoreStatus,
  SourceErasure,
  SourceId,
  Speaker,
  StepFailure,
  WayCounts,
  WorkOverview,
} from "@grasp-os/brain-next/contract";
import { skillCardOf, skillNameSchema } from "@grasp-os/brain-next/skills";
import { brainExportErrors } from "@grasp-os/shared/brain-exports";
import { brainMemoryErrors } from "@grasp-os/shared/brain-memories";
import type {
  BrainEntityKind,
  BrainMemoryAttribute,
} from "@grasp-os/shared/brain-memories";
import {
  brainReportSchema,
  brainSearchWays,
  brainSteps,
  brainWithoutMeaningReasons,
  storeNearLimit,
} from "@grasp-os/shared/brain-report";
import type {
  BrainAction,
  BrainActionOutcome,
  BrainErasureAnswer,
  BrainErasureLookup,
  BrainReport,
  BrainSearchWay,
  BrainStep,
  BrainWithoutMeaningReason,
} from "@grasp-os/shared/brain-report";
import { brainSourceErrors, firstLineOf } from "@grasp-os/shared/brain-sources";
import { isExpectedError } from "@grasp-os/shared/errors";
import { instructionFileErrors } from "@grasp-os/shared/instruction-files";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import type { ModelErrorCode } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { skillErrors } from "@grasp-os/shared/skills";
import { z } from "zod";

import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { erasureBegun } from "./brain-hand-overs.ts";
import {
  forgetOwnStoreHealth,
  keepOwnStoreHealth,
  ownStoresTotals,
} from "./brain-own-stores.ts";
import type { OwnStoreHealth } from "./brain-own-stores.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { embedInBulk, embedderModel, questionVectorOf } from "./embedder.ts";
import { parseModelRef } from "./model-catalog.ts";
import { brainSpendByPurpose, spendMonth } from "./model-spend.ts";
import { modelForRole, modelSettings, models } from "./models.ts";
import { organizationTimeZone } from "./organization.ts";
import { shippedSkills } from "./shipped-skills.ts";
import { skillCards, skillCardsKept } from "./skill-cards.ts";
import type { SkillCardText } from "./skill-cards.ts";
import { skillNeedsOf } from "./skill-needs.ts";
import type { SkillNeeds } from "./skill-needs.ts";

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

/**
 * `add`, its refusal while the Brain restores an export (contract.ts
 * `restoringNow`) answered as `brain.restoring`: a code a producer makes
 * the add again for, later, as after any failure of an add.
 */
const whileNotRestoring = async <T>(add: () => Promise<T>): Promise<T> => {
  try {
    return await add();
  } catch (error) {
    if (error instanceof Error && error.message === restoringNow) {
      throw brainExportErrors.create("brain.restoring");
    }
    throw error;
  }
};

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

/**
 * `input` as `schema` reads it, or refused as `brain.request_invalid`: an expected
 * error, so a caller over RPC gets that code, the audit log that reason,
 * and the log no stack. It names nothing of the input, not even its paths:
 * a key a caller sent is theirs.
 */
const checked = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw brainSourceErrors.create("brain.request_invalid");
  }
  return result.data;
};

/** The kind instruction files' keys are under (`instructionKeyOf`). */
const instructionsKind = "instructions";

/** The kind skills' keys are under (`skillKeyOf`). */
const skillsKind = "skill";

/**
 * `kinds`, which must hold no ":", and never `instructionsKind` or
 * `skillsKind`: a source's key is its kind, ":", and its id, so a kind
 * with ":" could name a key under another kind, and a kind `instructions`
 * or `skill` would name the instruction files' or the skills' keys (read
 * through `readSourceVersionAs`), letting a producer's text become a
 * skill. A list where one does doesn't compile.
 */
const kindsWithoutColon = <const K extends string>(
  kinds: readonly K[] &
    ([
      Extract<
        K,
        `${string}:${string}` | typeof instructionsKind | typeof skillsKind
      >,
    ] extends [never]
      ? unknown
      : never)
): readonly K[] => kinds;

/**
 * Everything that adds sources to the Brain, one kind each. Each producer
 * issue adds its own (GRA-1727: workflow runs; GRA-1824: uploads;
 * GRA-1730: what agents fetch). A kind is never `instructions`, the
 * instruction files' own (`instructionKeyOf`).
 *
 * A kind is only ever added, never removed or renamed: the Brain keeps
 * every key it was given, and recall reads each key's kind back
 * (`sourceRefOf`), so a kind gone from this list would fail every recall
 * whose results hold one of its sources.
 */
// `chat`: a turn of a person's own chat, in their own store alone, in its
// chat's group (brain-next-origins.ts `chatTurnSource`, GRA-1805).
// `capture`: what a chat's agent read through its person's own connection
// (connection-capture.ts, GRA-1730), in their own store alone.
const producerKinds = kindsWithoutColon(["upload", "chat", "run", "capture"]);

/**
 * The kinds the Sources page lists (`listSourcesAs`): not a chat's turns,
 * which its chat shows, and which would list as a row each. Recall still
 * finds them, each naming its chat.
 */
const listedKinds = producerKinds.filter((kind) => kind !== "chat");

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

/**
 * Whose words a source's text is, as core names them: a person of the
 * company speaking for themselves (or an admin), an outside party (a
 * customer's mail, a supplier's document), an agent, or the system. A
 * producer that can't say for sure says the least trusted one. Each
 * memory drawn records it; none drawn from a source is ever a preference
 * or an instruction, whoever's words they were.
 */
const saidBySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), personId: idSchema }),
  z.strictObject({ kind: z.literal("outside") }),
  z.strictObject({ kind: z.literal("agent"), agentId: idSchema }),
  z.strictObject({ kind: z.literal("system") }),
]);

/**
 * To draw memories from a version as it is added: whose words it is, when
 * they were said (what "next Friday" counts from, in the organization's
 * time zone), and which class of the Brain's work it takes.
 *
 * It describes ONE message's own words: one speaker, one moment. A thread
 * (a mail thread, a chat) is one source version per message, each with its
 * own `said`, and the producer strips the history a message quotes or
 * forwards before adding it: otherwise a customer's "we pay next Friday",
 * quoted in a colleague's reply, would become the colleague's word and
 * count from the reply's date. A document is one author's words at the
 * moment it was saved.
 */
const saidSchema = z.strictObject({
  by: saidBySchema,
  // From 1970 on, as the Brain takes it (`extractSchema`).
  at: z.date().min(new Date(0)),
  priority: z.enum(workPriorities),
});
export type Said = z.infer<typeof saidSchema>;

/** `by` as the Brain names whose word something is. */
const speakerOf = (by: Said["by"]): Speaker => {
  switch (by.kind) {
    case "person": {
      return { kind: "internal", person: by.personId };
    }
    case "agent": {
      return { kind: "agent", agent: by.agentId };
    }
    case "outside": {
      return { kind: "outside" };
    }
    case "system": {
      return { kind: "system" };
    }
    default: {
      throw new Error("Unknown speaker");
    }
  }
};

const newSourceSchema = z.strictObject({
  source: sourceRefSchema,
  change: changeSchema,
  text: wellFormedString(),
  readers: sourceReadersSchema,
  said: saidSchema.optional(),
  group: sourceRefSchema.optional(),
  readAt: z.date().optional(),
});

/** The most characters of a question `recallAs` takes, as the Brain's contract says. */
export { questionMaxLength as recallQuestionMaxLength } from "@grasp-os/brain-next/contract";

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

/**
 * What to recall: the question, the pack's budget, whether to read the
 * person's own store too, and the moment as of.
 */
export interface Recall {
  question: string;
  budget: { tokens: number };
  /**
   * Whether the pack may hold what only this person may read, from their
   * own store: only where the answer reaches them alone (their own web
   * chat, an agent's direct message with them). Apps, workflows and the
   * SDK pass `false`, so what is theirs alone never reaches App data or
   * anyone else; then their own store is never addressed.
   */
  personal: boolean;
  /**
   * Whether it reads only what everyone in the company may read: as no
   * person and no team, so neither the person's own content nor any
   * team's is found (`personal` is then ignored). Apps' and workflows'
   * recall (brain-recall.ts) does: what code is handed may end up where
   * any member reads it, so it holds nothing a member couldn't.
   */
  company?: boolean;
  /**
   * With `company`, the teams it reads beyond the company too: of these
   * (an App's grant's, brain-recall.ts), those the person is in now, so
   * never wider than the grant, nor than the person. None when absent.
   */
  teams?: readonly string[];
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

/**
 * A recall as code asks for one (an App's action, a workflow's step, a
 * chat's code: brain-recall.ts): the question and the budget, held to the
 * Brain's own limits, and the moment as an ISO 8601 date-time with its
 * offset, which crosses JSON where a `Date` can't. Nothing else, so code
 * never names a reader, groups or a vector.
 */
const codeRecallSchema = z.strictObject({
  question: recallRequestSchema.shape.question,
  budget: recallRequestSchema.shape.budget,
  asOf: z.iso.datetime({ offset: true }).optional(),
});

/** `input` as a recall code asks for (`codeRecallSchema`), or undefined. */
export const codeRecallOf = (
  input: unknown
): Omit<Recall, "personal"> | undefined => {
  const parsed = codeRecallSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const { question, budget, asOf } = parsed.data;
  return {
    question,
    budget,
    ...(asOf === undefined ? {} : { asOf: new Date(asOf) }),
  };
};

/** An item of a pack, citing its source as its producer named it. */
export interface RecalledItem extends Omit<PackItem, "source"> {
  source: SourceRef;
}

/** A memory of a pack, citing its source as its producer named it. */
export interface RecalledMemory extends Omit<PackMemory, "source"> {
  source: SourceVersionRef | null;
}

/** A pack, as recall answers (`recallAs`): passages and memories. */
export interface RecalledPack extends Omit<Pack, "items" | "memories"> {
  items: RecalledItem[];
  memories: RecalledMemory[];
}

/**
 * A pack of passages alone (`recallPassagesAs`): what the chat hands its
 * model and the Brain page shows, until each carries memories with their
 * own checks when history is read again.
 */
export interface RecalledPassages {
  items: RecalledItem[];
  notFound: string[];
  truncated: boolean;
}

/** `source` of the Brain as its producer named it, or none. */
const versionRefOf = (
  source: { source: SourceId; version: number } | null
): SourceVersionRef | null =>
  source === null
    ? null
    : { source: sourceRefOf(source.source), version: source.version };

/** A version of a source, whole. */
export interface SourceVersion extends SourceVersionRef {
  text: string;
  addedAt: Date;
}

type BrainEnv = Pick<Env, "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">;

// Two kinds of store (@grasp-os/brain-next `BrainStore`), both in core's
// jurisdiction: the shared one, holding what more than one person may
// read, and each person's own, holding what only they may read (`owner`).
// A source's store follows from its readers (`keptIn`), so a source
// keeps its kind of readers, and its person, for its whole life: who may
// read it changes only by a person's act that makes a new source (a new
// key). Narrowing a shared source to one person is refused (`keptIn`).
// Widening one person's own to a group can't be told apart from a new
// shared source without knowing whose it was, so producers never do it:
// were one to, the private versions would stay readable to their person
// alone and go with that person's erasure. Erasing a source closes its
// key in the shared store and, for one person's own, in theirs too
// (`eraseSource`). Whoever names a person's own store
// reaches what only they may read: `ownBrain` is the one place one is
// named, and each caller passes the reader core has just verified
// (`readerOf`), the owner named in the same call's access, or the person
// whose store is erased; never anyone else.

/** The shared store: what more than one person may read. */
const brain = (env: BrainEnv): Brain =>
  brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** `person`'s own store: what only they may read (above). */
const ownBrain = (env: BrainEnv, person: string): Brain =>
  personalBrainOf(inJurisdiction(env, env.BRAIN_STORE), person);

/**
 * The own store of `reader`, as `readerOf` verified them, or none for a
 * reader with no person (code's recall, as their teams alone): such a
 * reader never addresses anyone's own store.
 */
const ownBrainOf = (env: BrainEnv, reader: Reader): Brain | undefined =>
  reader.person === null ? undefined : ownBrain(env, reader.person);

/**
 * What the reader's own store answers to `read`, or `missing` when it
 * fails, logged by a fixed name alone: where a read joins what is shared
 * with what is theirs, their own part may go missing, never the shared
 * part. (A recall that reads their own store fails instead: it would
 * answer as if they held nothing.)
 */
const ownOr = async <T>(read: () => Promise<T>, missing: T): Promise<T> => {
  try {
    return await read();
  } catch {
    log.warn("brain.own_store_unavailable", {});
    return missing;
  }
};

/** What an add that would narrow a shared source to one person answers. */
const narrowed =
  "Refused: a source keeps the readers it was first added for, so one added for more than one person can't become one person's own: add it as a new source";

/**
 * The refusal of an add of a key the shared store has (`keyState`): as
 * erased when an erasure closed it there (`erasedSource`, which
 * producers take as final), as narrowed when a version of it is kept.
 */
const refusalOf = (state: KeyState): Error =>
  new Error(state === "erased" ? erasedSource : narrowed);

/**
 * `add` run on the store `source` is kept in for `access` (`keptIn`).
 * One person's own only while the shared store was never given its key,
 * asked before and again after: a shared source is never narrowed into a
 * person's own store, where its shared versions would stay readable to
 * those taken off. A shared add of the key that landed in between (two
 * producers at once) has the key erased and closed in their own store,
 * every version of it, and this add refused; one after the second ask is
 * a widening, which producers never do. So an earlier version of theirs
 * is lost only when a team add of the same key lands between the two asks
 * of a later add of theirs: a producer's bug. A refusal at the first ask
 * erases nothing: it can't tell what an earlier add of theirs kept from a
 * copy a failed call left, and a refused call never erases a person's own
 * content. What a failed second ask or clean-up leaves is theirs alone to
 * read, and goes with their erasure.
 */
const keptIn = async <T>(
  env: BrainEnv,
  source: SourceId,
  access: Access,
  add: (store: Brain) => Promise<T>
): Promise<T> => {
  if (access.kind !== "owner") {
    return await add(brain(env));
  }
  const shared = brain(env);
  const before = await shared.keyState(source);
  if (before !== "free") {
    throw refusalOf(before);
  }
  const own = ownBrain(env, access.person);
  const added = await add(own);
  const after = await shared.keyState(source);
  if (after !== "free") {
    // A clean-up that fails throws its own error: the add failed.
    await own.eraseSource({ source, reason: "deleted" });
    throw refusalOf(after);
  }
  return added;
};

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
 * Whom a reader reads as: the person, the teams core counts them in and
 * the company (`person`); those teams and the company, as no person
 * (`teams`); or the company alone, as no person and no team (`company`),
 * which reads only what every member may. Every reach of a current member
 * holds the company: what everyone may read, each of them may. A guest or
 * a visitor is never a member, so never a reader here.
 */
export type Reach = "person" | "teams" | "company";

/** Every current member is in this group, and in no other way. */
const companyGroup = "company";

/**
 * The member `personId` as the Brain's reader: the person, their teams as
 * core counts them now, and the company. Refused once they have no
 * current membership.
 */
const personReaderOf = async (
  env: Pick<Env, "DB">,
  personId: string
): Promise<PersonReader> => {
  const member = await memberOf(env.DB, checked(idSchema, personId));
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return {
    person: member.userId,
    groups: [...member.teams.map(({ id }) => teamGroup(id)), companyGroup],
  };
};

/**
 * The member `personId` as the Brain's reader, as far as `reach` goes
 * (`Reach`), and with `company`, of `teams` those they are in now.
 * Refused once they have no current membership, whatever the reach.
 */
const readerOf = async (
  env: Pick<Env, "DB">,
  personId: string,
  reach: Reach,
  teams: readonly string[] = []
): Promise<Reader> => {
  const { person, groups } = await personReaderOf(env, personId);
  switch (reach) {
    case "person": {
      return { person, groups };
    }
    case "teams": {
      return { person: null, groups };
    }
    case "company": {
      // Of `teams`, those the person is in now: a group of theirs.
      const named = new Set(teams.map((id) => teamGroup(id)));
      return {
        person: null,
        groups: [...groups.filter((group) => named.has(group)), companyGroup],
      };
    }
    default: {
      throw new Error("Unknown reach");
    }
  }
};

/**
 * Adds `text` to the Brain as a version of `source` that `readers` may
 * read; it replaces the version before in recall, which stays as history.
 * What only one person may read (`owner`) is kept in their own store,
 * anything else in the shared one; a source keeps its kind of readers,
 * and its person, for its whole life (`keptIn`): `owner` readers for a
 * source the shared store holds are refused.
 *
 * `group`, for a source of one person alone, names the source it is
 * erased with: erasing the group (`eraseSource` of it) erases every
 * source added in it, in one call to their own store, and refuses every
 * add in it from then on. Of the same producer, its id the start of the
 * source's, then "/"; a source keeps the group of its first add.
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
 * source before it calls this; the Brain can't tell. An add an erasure
 * closed is refused with `brain.source_erased`: final, never retried.
 *
 * With `said`, the Brain also draws memories from the version on its work
 * queue, in `said.priority`'s class: whose words it is (`said.by`, the
 * producer's to know, recorded on every memory drawn) and when they were
 * said. Without it, the
 * version is kept and found, and nothing is drawn from it.
 */
export const addSource = async (
  env: BrainEnv & Pick<Env, "DB">,
  added: {
    source: SourceRef;
    change: string;
    text: string;
    readers: SourceReaders;
    said?: Said;
    group?: SourceRef;
    /**
     * When the producer read `text` where it lives: a text read before the
     * source's current version was is not added (`newer`), whatever order
     * the adds arrive in.
     */
    readAt?: Date;
  }
): Promise<SourceVersionRef & { newer?: true }> => {
  const { source, change, text, readers, said, group, readAt } = checked(
    newSourceSchema,
    added
  );
  if (
    group !== undefined &&
    (readers.kind !== "owner" || group.producer !== source.producer)
  ) {
    throw new Error(
      "Refused: only a source for one person alone is in a group, of its own producer"
    );
  }
  // What an agent read through a person's own connection is theirs alone
  // (connection-capture.ts): never in the shared store, so never in a
  // recall that doesn't read their own store, such as code's.
  if (source.producer === "capture" && readers.kind !== "owner") {
    throw new Error("Refused: a capture is for one person alone");
  }
  const access = accessOf(readers);
  const key = sourceKeyOf(source);
  const extract =
    said === undefined
      ? {}
      : {
          extract: {
            speaker: speakerOf(said.by),
            saidAt: said.at,
            timeZone: await organizationTimeZone(env.DB),
            priority: said.priority,
          },
        };
  let version: number;
  let newer: true | undefined;
  try {
    ({ version, newer } = await whileNotRestoring(
      async () =>
        await keptIn(
          env,
          key,
          access,
          async (store) =>
            await store.addSource({
              source: key,
              change,
              text,
              access,
              ...extract,
              ...(group === undefined ? {} : { group: sourceKeyOf(group) }),
              ...(readAt === undefined ? {} : { readAt: readAt.getTime() }),
            })
        )
    ));
  } catch (error) {
    // The Brain's own refusals of what an erasure closed, by their whole
    // message (@grasp-os/brain-next/contract): a source's key, or a
    // person's own store erased whole. A code producers can test.
    if (
      error instanceof Error &&
      (error.message === erasedSource || error.message === storeErased)
    ) {
      throw brainSourceErrors.create("brain.source_erased");
    }
    throw error;
  }
  return { source, version, ...(newer === true ? { newer } : {}) };
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
 * The Brain's request of a recall by the member `personId`, as core counts
 * them now: the question checked as the Brain checks it before the
 * embedder sees any of it, and embedded while their reader is read. With
 * `personal`, as the person (`person`: their own store too); without, as
 * their teams (a reader with no person: no `owner` source matches); with
 * `company`, as the company and, of `teams`, those they are in now.
 */
const recallRequestAs = async (
  env: BrainEnv & Pick<Env, "DB" | "EMBEDDER">,
  personId: string,
  { question: asked, budget, asOf, personal, company = false, teams }: Recall
): Promise<RecallRequest> => {
  const question = checked(questionSchema, asked);
  let reach: Reach = personal ? "person" : "teams";
  if (company) {
    reach = "company";
  }
  const [reader, meaning] = await Promise.all([
    readerOf(env, personId, reach, teams),
    // As of a moment the Brain never searches by meaning: nothing to embed.
    asOf === undefined ? meaningOf(env, question) : {},
  ]);
  return {
    question,
    reader,
    budget,
    ...(asOf === undefined ? {} : { asOf }),
    ...meaning,
  };
};

/**
 * What every store `request`'s reader may read from finds for it, by
 * `finding` (`find`, or `findPassages` for passages alone): the shared
 * store, and their own when the reader names them (`ownBrainOf`), the
 * shared store first, as ties go to the store given first.
 */
const findingsOf = async (
  env: BrainEnv,
  request: RecallRequest,
  finding: "find" | "findPassages"
): Promise<Finding[]> => {
  const own = ownBrainOf(env, request.reader);
  return await Promise.all([
    brain(env)[finding](request),
    ...(own === undefined ? [] : [own[finding](request)]),
  ]);
};

/** `items` of a pack, each citing its source as its producer named it. */
const recalledItems = (items: Pack["items"]): RecalledItem[] =>
  items.map(({ source, version, position, text, whole, found }) => ({
    source: sourceRefOf(source),
    version,
    position,
    text,
    whole,
    found,
  }));

/**
 * A pack of what the member `personId` may read for `question`, as core
 * counts them now, within `budget.tokens` (the Brain's estimate,
 * `tokensOf`), and, with `asOf`, of each source as it was then: the
 * Brain's `recall`, by words, exact parts, the entities the question
 * names and, once a model ships, by meaning: passages and memories, each
 * citing its source, version and place, and the contested facts among
 * them; what was not found and whether the budget cut it short, all from
 * what they may read alone. With `personal`, from the shared store and
 * their own together, packed as one store holding both would pack them
 * (`packAcross`); without, from the shared store alone, as their teams
 * may read it, or with `company` as the company and, of `teams`, those they
 * are in. Refused once they are no longer a member, or when `personId` isn't an ID. For a caller
 * that hands memories on with their own checks: none yet. The chat, the
 * Brain page and code (`recallFor`) take passages alone
 * (`recallPassagesAs`).
 */
export const recallAs = async (
  env: BrainEnv & Pick<Env, "DB" | "EMBEDDER">,
  personId: string,
  recall: Recall
): Promise<RecalledPack> => {
  const request = await recallRequestAs(env, personId, recall);
  const { items, memories, contested, notFound, truncated } = packAcross(
    request.question,
    request.budget.tokens,
    await findingsOf(env, request, "find")
  );
  return {
    items: recalledItems(items),
    memories: memories.map((memory) => ({
      ...memory,
      source: versionRefOf(memory.source),
    })),
    contested,
    notFound,
    truncated,
  };
};

/**
 * A pack of the passages alone that the member `personId` may read for
 * `question`, as `recallAs` finds them, the whole budget theirs: the
 * stores find passages alone (`findPassages`), so no memory is read,
 * takes room, reaches the caller, or counts as found in `notFound`, and
 * no memory way can fail the recall. What the
 * chat hands its model and the Brain page shows (GRA-1742: memories reach
 * them in their own pull request, re-checked when history is read again),
 * and what code recalls (`recallFor`, the SDK's `BrainPack`).
 */
export const recallPassagesAs = async (
  env: BrainEnv & Pick<Env, "DB" | "EMBEDDER">,
  personId: string,
  recall: Recall
): Promise<RecalledPassages> => {
  const request = await recallRequestAs(env, personId, recall);
  const { items, notFound, truncated } = packAcross(
    request.question,
    request.budget.tokens,
    await findingsOf(env, request, "findPassages")
  );
  return { items: recalledItems(items), notFound, truncated };
};

/** Where an item of a pack is: its source, version and place. */
const placeOf = ({ source, version, position }: RecalledItem): string =>
  JSON.stringify([sourceKeyOf(source), version, position]);

/**
 * Two recalls of passages for one reader as one pack within
 * `budget.tokens`, as one pass over both would fit them: the first's
 * items in their order, then the second's that the first doesn't hold
 * (the same passage of the same version), best first, each while it fits
 * in what is left, as the Brain counts it (`packItemTokens`). Cut short
 * when either was or anything was left out for room. What was not found
 * is the second's: it was asked for what the first meant. Both must be
 * packs of the same reader's, as `recallPassagesAs` gave them.
 */
export const mergeRecalled = (
  first: RecalledPassages,
  second: RecalledPassages,
  budget: { tokens: number }
): RecalledPassages => {
  let used = 0;
  let truncated = first.truncated || second.truncated;
  const held = new Set<string>();
  const items: RecalledItem[] = [];
  for (const item of [...first.items, ...second.items]) {
    const place = placeOf(item);
    if (held.has(place)) {
      continue;
    }
    const tokens = packItemTokens({
      ...item,
      source: sourceKeyOf(item.source),
    });
    if (used + tokens > budget.tokens) {
      truncated = true;
      continue;
    }
    held.add(place);
    items.push(item);
    used += tokens;
  }
  return { items, notFound: second.notFound, truncated };
};

/**
 * Version `version` of `source`, current or history, whole, for the
 * member `personId`: only if they are among that version's readers and
 * the current version's, so narrowing a source's readers hides its
 * history from those taken off. Both are read with the teams core counts
 * them in now: someone who joins a team reads the history that team
 * could read from before they joined. `null` when there is none or they
 * may not, alike. Asked of the shared store first, and of their own only
 * when the shared one has no version they may read: a source is in one of
 * them (`keptIn`), and a shared one stays readable whatever their own
 * store does. Refused once they are no longer a member. For the server
 * only, as `addSource`.
 */
export const readSourceVersionAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: { source: SourceRef; version: number }
): Promise<SourceVersion | null> => {
  const { source, version } = checked(versionRefSchema, wanted);
  const reader = await personReaderOf(env, personId);
  const request = { source: sourceKeyOf(source), version, reader };
  const read =
    (await brain(env).readVersion(request)) ??
    (await ownBrainOf(env, reader)?.readVersion(request)) ??
    null;
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
 * read takes no place in it. Of the shared store and their own, merged as
 * one store holding both would list them (`sourcesAcross`); the shared
 * one's alone while their own store fails (`ownOr`). Refused once they
 * are no longer a member.
 */
export const listSourcesAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  { after }: { after?: SourcesAfter } = {}
): Promise<SourcePage> => {
  const from =
    after === undefined ? undefined : checked(sourcesAfterSchema, after);
  const reader = await personReaderOf(env, personId);
  const request = {
    reader,
    prefixes: listedKinds.map((kind) => `${kind}:`),
    ...(from === undefined
      ? {}
      : { after: { addedAt: from.addedAt, source: sourceKeyOf(from.source) } }),
  };
  const { sources, more } = sourcesAcross(
    await Promise.all([
      brain(env).listSources(request),
      ownOr(
        async () =>
          (await ownBrainOf(env, reader)?.listSources(request)) ?? {
            sources: [],
            more: false,
          },
        {
          sources: [],
          more: false,
        }
      ),
    ])
  );
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
 * a source there isn't. Of the shared store, and of their own only when
 * the shared one lists none of it: a source is in one of them, and a
 * shared one's history stays listed whatever their own store does.
 * Refused once they are no longer a member.
 */
export const listVersionsAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: { source: SourceRef; before?: number }
): Promise<VersionPage> => {
  const { source, before } = checked(versionsWantedSchema, wanted);
  const reader = await personReaderOf(env, personId);
  const request = {
    source: sourceKeyOf(source),
    reader,
    ...(before === undefined ? {} : { before }),
  };
  const shared = await brain(env).listVersions(request);
  const { versions, more } =
    shared.versions.length > 0
      ? shared
      : ((await ownBrainOf(env, reader)?.listVersions(request)) ?? shared);
  const last = versions.at(-1);
  return {
    versions: versions.map(({ version, addedAt }) => ({ version, addedAt })),
    before: more && last !== undefined ? last.version : null,
  };
};

/** A version as a key of the Brain names it, as one string. */
const versionKeyOf = ({
  source,
  version,
}: {
  source: string;
  version: number;
}): string => `${version}:${source}`;

/** Of `versions` (keys), those `reader` may read in `store` now. */
const readableIn = async (
  store: Brain,
  reader: Reader,
  versions: readonly { source: string; version: number }[]
): Promise<{ source: string; version: number }[]> => {
  const parts = Array.from(
    { length: Math.ceil(versions.length / readableCheckMax) },
    (_, at) =>
      versions.slice(at * readableCheckMax, (at + 1) * readableCheckMax)
  );
  const readable = await Promise.all(
    parts.map(
      async (part) =>
        await store.readableVersions({ versions: [...part], reader })
    )
  );
  return readable.flat();
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
  readers: sourceReadersSchema,
  reason: z.enum(erasureReasons),
  asGroup: z.literal(true).optional(),
});

const personErasureSchema = z.strictObject({
  personId: idSchema,
  reason: z.enum(erasureReasons),
});

/**
 * Erases `request` from `personId`'s own store, then closes its key in the
 * shared store: the one way anything kept in a person's own store is
 * erased (`eraseSource`, `eraseOwnGroup`), so every such erasure is in
 * the shared ledger, which staff's erasure lookup reads (brain-report.ts),
 * and none is answered "not erased" there. The shared entry is the key's
 * hash and a time, never content; the shared store holds nothing under
 * the key, and holds no group (it ignores `asGroup`). Only once the own
 * store returned: the shared ledger never says erased while a copy can
 * be read or come back after a restore. A failure of either throws, and
 * the caller's retry does both, in order; both are safe to repeat.
 * Answers what the own store answered.
 */
const erasedFromOwnStore = async (
  env: BrainEnv,
  personId: string,
  request: SourceErasure
): Promise<Awaited<ReturnType<Brain["eraseSource"]>>> => {
  const answered = await ownBrain(env, personId).eraseSource(request);
  await brain(env).eraseSource({
    source: request.source,
    reason: request.reason,
  });
  return answered;
};

/**
 * Erases `source` for good: every version, with everything kept of it,
 * and every source added in it as their group (`addSource`), all in one
 * call to the store. Its key is closed: a later add of it, or in it as a
 * group, is refused, so a producer's late retry never brings it back. Safe to repeat. For a producer's deletion
 * for good, or the end of its retention. `readers` are the source's, as
 * its producer adds it: its key is closed in the person's own store when
 * they name one, then in the shared store (`keptIn`).
 *
 * Only a call that returned is in the Brain's ledger. A call that fails
 * or throws must be retried until it succeeds: until then, a restore of
 * the Brain's store can bring the source back.
 */
export const eraseSource = async (
  env: BrainEnv,
  erased: {
    source: SourceRef;
    readers: SourceReaders;
    reason: ErasureReason;
    /**
     * That `source` is a group's (`addSource`'s `group`), though no add
     * may have named it yet: its person's own store erases it as one, so
     * every key under it stays refused, even after a restore of that
     * store. For one person's own alone; the shared store holds no group.
     */
    asGroup?: true;
  }
): Promise<void> => {
  const { source, readers, reason, asGroup } = checked(
    sourceErasureSchema,
    erased
  );
  const request = { source: sourceKeyOf(source), reason };
  if (readers.kind === "owner") {
    await erasedFromOwnStore(env, readers.personId, {
      ...request,
      ...(asGroup === undefined ? {} : { asGroup }),
    });
    return;
  }
  await brain(env).eraseSource(request);
};

const ownGroupErasureSchema = z.strictObject({
  personId: idSchema,
  group: sourceRefSchema,
  reason: z.enum(erasureReasons),
});

/**
 * Erases the group `group` (`addSource`'s `group`) from `personId`'s own
 * store, as `eraseSource` with `asGroup` does there: every source added
 * in it, in one call, and the group closed, so a later add in it is
 * refused, also after a restore of the store. For a group only their own
 * store can hold content of: what an agent read through their own
 * connection (core's `addSource` refuses a capture any other readers).
 * Its key is then closed in the shared ledger too, as every erasure from
 * an own store is (`erasedFromOwnStore`): a record, not content, so
 * staff's lookup answers erased for it. Answers how many sources it
 * erased, the same each time it is repeated (none once their store was
 * erased whole). Safe to repeat; one that throws, in either store, must
 * be repeated until it answers.
 */
export const eraseOwnGroup = async (
  env: BrainEnv,
  erased: { personId: string; group: SourceRef; reason: ErasureReason }
): Promise<number> => {
  const { personId, group, reason } = checked(ownGroupErasureSchema, erased);
  const answered = await erasedFromOwnStore(env, personId, {
    source: sourceKeyOf(group),
    reason,
    asGroup: true,
  });
  if (answered === undefined) {
    throw new Error("A person's own store answers what it erased");
  }
  return answered.sources;
};

/**
 * Erases what only `personId` may read, added up to now: their own
 * sources' every version (their uploads, chats and runs, their
 * instruction file), and, in a source others read now, the versions that
 * were theirs alone. Content added for them later is new. Safe to repeat.
 * For an admin's erasure of a person (`person_erased`), or a person's
 * withdrawal (`withdrawn`).
 *
 * In the shared store, and, for `person_erased` alone, then their own
 * store, whole: deleted for good, it holds nothing and takes nothing from
 * then on. A withdrawal never touches their own store: they stay a
 * member, and what they withdraw (an interview) is erased as its source
 * (`eraseSource`).
 *
 * Answers `erased` once it is all done, or `still_deleting` while their
 * own store waits out the time an add under way has to write a file
 * (about 15 minutes after the first call): no failure, so the caller
 * keeps the erasure pending, quietly, and calls again. Throws when it
 * failed (the record of an erasure couldn't be written, say).
 *
 * Only a call that answered `erased` is done. Until then, a restore of
 * the Brain's store can bring what it covers back.
 */
export const erasePerson = async (
  env: BrainEnv & Pick<Env, "DB">,
  erased: { personId: string; reason: ErasureReason }
): Promise<"erased" | "still_deleting"> => {
  const { personId, reason } = checked(personErasureSchema, erased);
  await brain(env).erasePerson({ person: personId, reason });
  if (reason !== "person_erased") {
    return "erased";
  }
  try {
    await ownBrain(env, personId).erasePerson({ person: personId, reason });
  } catch (error) {
    if (isStillDeleting(error)) {
      return "still_deleting";
    }
    throw error;
  }
  // Only once their store is erased, so no tick of it under way can write
  // the row again (the store counts its report as a write under way). A
  // failure throws, and the caller's retry removes it.
  await forgetOwnStoreHealth(env, personId);
  return "erased";
};

/**
 * Whether a person's erasure asked for at `askedAt` has had their own store
 * answer that it is still deleting for longer than the Brain allows
 * (`stillDeletingAtMostMs`: two graces and an item's time): then it is
 * stuck, and person-erasure.ts counts and logs it.
 */
export const stillDeletingTooLong = (
  askedAt: Date,
  now: Date = new Date()
): boolean => now.getTime() - askedAt.getTime() > stillDeletingAtMostMs;

// Exports and restores (@grasp-os/brain-next exports.ts, restore.ts): the
// company's Brain, for an admin; core's route checks who asks
// (brain-next-exports.ts). A person's own export (GRA-1839) is written in
// their own store, of what only they may read, and only they start and
// read it: the person is the one core's route verified, never one a
// request names.

const exportRefSchema = z.strictObject({ id: exportIdSchema });

/** An export, by its id. */
export type ExportRef = z.infer<typeof exportRefSchema>;

const exportFileRefSchema = exportRefSchema.extend({
  file: exportFileNameSchema,
});

/** A file of an export, by its id and name. */
export type ExportFileRef = z.infer<typeof exportFileRefSchema>;

type ExportEnv = Pick<
  Env,
  "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION" | "CLIENT_ID"
>;

/**
 * The deployment an export is of, as its manifest names it: the client
 * the admin deployed, or `local` where none is set (local development and
 * on-prem, a deployment of its own). A restore refuses another's. On-prem
 * every install is `local`, so there the check tells little: an export
 * moved from one install's bucket to another's would pass it.
 */
const deploymentOf = (env: Pick<Env, "CLIENT_ID">): string =>
  env.CLIENT_ID ?? "local";

/**
 * Starts an export of the company's Brain, or answers with the one being
 * written. Refused as `brain.export_refused` while a restore runs.
 */
export const startBrainExport = async (
  env: ExportEnv
): Promise<{ id: string }> => {
  try {
    return await brain(env).startExport(deploymentOf(env));
  } catch (error) {
    // Refused for the state the Brain is in (a restore runs).
    if (error instanceof Error && error.message.startsWith(refusalPrefix)) {
      throw brainExportErrors.create("brain.export_refused");
    }
    throw error;
  }
};

/** Where export `ref` is: null when there is none. */
export const brainExportStatus = async (
  env: ExportEnv,
  ref: ExportRef
): Promise<ExportStatus | null> =>
  await brain(env).exportStatus(checked(exportRefSchema, ref));

/**
 * A file of done export `ref`: null for any other, alike, and for one the
 * ledger made stale.
 */
export const brainExportFile = async (
  env: ExportEnv,
  ref: ExportFileRef
): Promise<string | null> => {
  // A name the Brain's one rule of an export's files doesn't take names
  // no file: answered as such.
  const asked = exportFileRefSchema.safeParse(ref);
  return asked.success ? await brain(env).exportFile(asked.data) : null;
};

/**
 * Starts restoring the company's export `exportId` into the shared store,
 * which must hold nothing, the erasure ledger applied over all it brings
 * back; nothing is added to the store while it runs. `prepare` runs once
 * the Brain says the restore may start, before it does (core's route
 * installs Grasp's own skills there), and answers whether it is done: when
 * it isn't, the restore doesn't start, refused as
 * `brain.restore_unprepared`, to try again. A restore the Brain won't start (the store holds something, one is under way, or no whole
 * export of this deployment's company has that id) is refused as
 * `brain.restore_refused`. For an admin only: core's route checks.
 */
export const startBrainRestore = async (
  env: ExportEnv,
  exportId: string,
  prepare?: () => Promise<boolean>
): Promise<RestoreStatus> => {
  const id = checked(exportIdSchema, exportId);
  try {
    // Checked first, so `prepare` runs only for a restore that may start.
    await brain(env).checkRestore(id, deploymentOf(env));
    if (prepare !== undefined && !(await prepare())) {
      throw brainExportErrors.create("brain.restore_unprepared");
    }
    return await brain(env).startRestore(id, deploymentOf(env));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(refusalPrefix)) {
      throw brainExportErrors.create("brain.restore_refused");
    }
    throw error;
  }
};

/**
 * Starts `person`'s own export, of what only they may read, or answers
 * with the one being written. Only for the person core verified.
 */
export const startOwnBrainExport = async (
  env: ExportEnv,
  person: string
): Promise<{ id: string }> =>
  await ownBrain(env, person).startOwnExport({
    person,
    deployment: deploymentOf(env),
  });

/**
 * The export `person`'s own store shows them: their most recent one,
 * whatever came of it; null when there is none. Only for the person core
 * verified.
 */
export const ownBrainExport = async (
  env: ExportEnv,
  person: string
): Promise<ExportStatus | null> =>
  await ownBrain(env, person).ownExport({ person });

/**
 * A file of `person`'s own done export `ref`: null for any other, alike,
 * and for one the ledger made stale. Only for the person core verified.
 */
export const ownBrainExportFile = async (
  env: ExportEnv,
  person: string,
  ref: ExportFileRef
): Promise<string | null> => {
  const asked = exportFileRefSchema.safeParse(ref);
  return asked.success
    ? await ownBrain(env, person).ownExportFile({ person, ...asked.data })
    : null;
};

/** Where the restore of the company's export `exportId` is: null when none was started. */
export const brainRestoreStatus = async (
  env: BrainEnv,
  exportId: string
): Promise<RestoreStatus | null> =>
  await brain(env).restoreStatus(checked(exportIdSchema, exportId));

// Instruction files: what people write for every chat to start with (the
// company's instructions and lasting facts, a person's own file, an App's
// and an agent's), each a source of its own under `instructions:`, kept
// whole and versioned, never indexed, so recall never returns one. Who
// may read each in the Brain: a person's file, that person, in their own
// store alone (`keptIn`; the shared store refuses it); an App's, the
// App's group, which core puts in a reader only once they passed the
// builder check; the company's and agents', the company. Which of them
// reaches which chat or run, and who may write each, is
// instruction-files.ts's rule; the functions here only name them for the
// Brain.

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
  const access = instructionAccessOf(file);
  const key = instructionKeyOf(file);
  const { version } = await whileNotRestoring(
    async () =>
      await keptIn(
        env,
        key,
        access,
        async (store) =>
          await store.addInstructions({
            source: key,
            change,
            text: added.text,
            access,
          })
      )
  );
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
  const reader = { person: checked(idSchema, member.userId), groups };
  // A person's file is in their own store (`keptIn`): only the reader's
  // own is asked of, there, and their store only when it is wanted.
  // Another person's is left out as a file never written is, and their
  // store is never addressed.
  const ownFile = files.filter(
    (file) => file.scope === "person" && file.personId === reader.person
  );
  const sharedFiles = files.filter((file) => file.scope !== "person");
  const [fromShared, fromOwn] = await Promise.all([
    brain(env).readCurrent({
      sources: sharedFiles.map((file) => instructionKeyOf(file)),
      reader,
    }),
    // Their own file is left out while their store fails, never the rest.
    ownFile.length === 0
      ? []
      : ownOr(
          async () =>
            await ownBrain(env, reader.person).readCurrent({
              sources: ownFile.map((file) => instructionKeyOf(file)),
              reader,
            }),
          []
        ),
  ]);
  const read = new Map(
    [...fromShared, ...fromOwn].map((current) => [current.source, current])
  );
  // Each file once, in the order given.
  const byKey = new Map(files.map((file) => [instructionKeyOf(file), file]));
  return [...byKey].flatMap(([key, file]) => {
    const current = read.get(key);
    return current === undefined
      ? []
      : [
          {
            file,
            version: current.version,
            text: current.text,
            addedAt: current.addedAt,
          },
        ];
  });
};

// Skills (GRA-1826, GRA-1754, GRA-1844): how things are done, as
// `SKILL.md` documents, kept whole like instruction files (never indexed,
// so recall never returns one), each a source under `skillsKind`:
//
// - Grasp's own (`scope` "grasp"), which each release ships, readable by
//   every current member, as the company's instruction file.
// - Shared ones, each for an audience (`SkillAudience`), added only as an
//   admin's decision on a share says (`writeSharedSkill`, from
//   skill-shares.ts), in the shared store: the company's (`company`),
//   readable by every current member, and a team's (`team`), readable by
//   that team's members alone, as core counts them at each read. Which
//   of them a reader gets is the store's to filter, by the reader's
//   groups, in its own statement.
// - A person's own (`person`), which they write for themselves
//   (`addOwnSkill`): in their own store (`ownBrain`), readable by them
//   alone (`owner`), never in the shared one. Its key names no person
//   (`skill:person:<name>`): the store it is in is the person's, and only
//   the reader core has just verified ever names that store.
//
// A skill is guidance and grants no access. Which skills a chat gets is
// brain-skills.ts's rule (a skill's needs, and which of one name takes
// the place of another), and who may share or decide one is
// skill-shares.ts's; each writer here checks who calls it too. No producer
// can name a skill's key (`kindsWithoutColon`).

/** Where a skill comes from: Grasp's release, the company, a team, or one person. */
const skillScopes = ["grasp", "company", "team", "person"] as const;

/** Where a skill comes from. */
export type SkillScope = (typeof skillScopes)[number];

const skillSchema = z.union([
  z.strictObject({
    scope: z.enum(["grasp", "company", "person"]),
    name: skillNameSchema,
  }),
  z.strictObject({
    scope: z.literal("team"),
    team: idSchema,
    name: skillNameSchema,
  }),
]);

/** A skill, by where it comes from (a team's, by its team) and its name. */
export type Skill = z.infer<typeof skillSchema>;

const versionSchema = z.int().positive();

const skillAtSchema = z.union([
  z.strictObject({
    scope: z.enum(["grasp", "company", "person"]),
    name: skillNameSchema,
    version: versionSchema,
  }),
  z.strictObject({
    scope: z.literal("team"),
    team: idSchema,
    name: skillNameSchema,
    version: versionSchema,
  }),
]);

/** A skill at one version: what a selection pins, and a read takes. */
export type SkillAt = z.infer<typeof skillAtSchema>;

/** A skill at its current version, and when to use it. */
export type SkillCardAt = SkillAt & { description: string };

/**
 * A skill at its current version, when to use it, and what it needs to be
 * of use; a team's, with its team's name too.
 */
export type SkillListed = SkillCardAt & {
  needs: SkillNeeds;
  teamName?: string;
};

/** A skill at one version, whole. */
export type SkillVersion = SkillAt & { text: string };

/** The keys of the teams' skills start with this; then the team's ID, ":", and the name. */
const teamSkillPrefix = `${skillsKind}:team:`;

/** The Brain's key for `skill`: its scope is part of it, and a team's skill its team. */
const skillKeyOf = (skill: Skill): SourceId =>
  skill.scope === "team"
    ? `${teamSkillPrefix}${skill.team}:${skill.name}`
    : `${skillsKind}:${skill.scope}:${skill.name}`;

/** `key` as the skill it names, or null for one that isn't a skill's. */
const skillOfKey = (key: SourceId): Skill | null => {
  if (key.startsWith(teamSkillPrefix)) {
    // A name holds no ":": the last one ends the team's ID.
    const rest = key.slice(teamSkillPrefix.length);
    const at = rest.lastIndexOf(":");
    const parsed = skillSchema.safeParse({
      scope: "team",
      team: rest.slice(0, at),
      name: rest.slice(at + 1),
    });
    return at > 0 && parsed.success ? parsed.data : null;
  }
  const [kind, scope, name, ...rest] = key.split(":");
  const parsed = skillSchema.safeParse({ scope, name });
  return kind === skillsKind && rest.length === 0 && parsed.success
    ? parsed.data
    : null;
};

/**
 * A skill's version as a run keeps it beside what it recalled
 * (workflows/run-evidence.ts): the skills' kind, then its scope and name,
 * as its key has them, so the run's checks read it as they read a
 * recalled version (`readableVersionsAs`).
 */
export interface SkillVersionRef {
  source: { producer: typeof skillsKind; id: string };
  version: number;
}

/**
 * `skill` at its version as a run keeps it (`SkillVersionRef`), whatever
 * else it carries (a selection's description).
 */
export const skillVersionRefOf = (given: SkillAt): SkillVersionRef => {
  const at = checked(
    skillAtSchema,
    given.scope === "team"
      ? {
          scope: given.scope,
          team: given.team,
          name: given.name,
          version: given.version,
        }
      : { scope: given.scope, name: given.name, version: given.version }
  );
  return {
    source: {
      producer: skillsKind,
      id: skillKeyOf(at).slice(skillsKind.length + 1),
    },
    version: at.version,
  };
};

/** A skill's version as `SkillVersionRef` names it, read back as its skill. */
const skillVersionRefSchema = z.strictObject({
  source: z.strictObject({
    producer: z.literal(skillsKind),
    id: z.string().transform((id, context) => {
      const skill = skillOfKey(`${skillsKind}:${id}`);
      if (skill === null) {
        context.addIssue({ code: "custom", message: "Not a skill" });
        return z.NEVER;
      }
      return skill;
    }),
  }),
  version: z.int().positive(),
});

/** A version core checks is still readable: a source's or a skill's. */
export type PinnedVersionRef = SourceVersionRef | SkillVersionRef;

const pinnedVersionRefsSchema = z.array(
  z.union([versionRefSchema, skillVersionRefSchema])
);

/**
 * Of `versions`, those the member `personId` may read now, as
 * `readSourceVersionAs` decides it, in the order given and each once,
 * without reading their text: for core to check what a chat once read
 * before it sends it again (history-access.ts), or a run what it
 * recalled (workflows/resource-reads.ts): as far as `reach` goes, as the
 * recall that handed them read; a skill's version too, as a run that
 * read it keeps it (`skillVersionRefOf`). Of the shared store, and of
 * their own for those the shared one doesn't answer (with the `person`
 * reach alone): a source is in one of them (`keptIn`). Their own store
 * failing answers none of its own (`ownOr`): what can't be checked is
 * withheld. Refused once they are no longer a member. For the server
 * only, as `addSource`.
 */
export const readableVersionsAs = async <Ref extends PinnedVersionRef>(
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  versions: readonly Ref[],
  { reach = "person" }: { reach?: Reach } = {}
): Promise<Ref[]> => {
  const asked = checked(pinnedVersionRefsSchema, versions).map(
    ({ source, version }) => ({
      source:
        source.producer === skillsKind
          ? skillKeyOf(source.id)
          : sourceKeyOf(source),
      version,
    })
  );
  if (asked.length === 0) {
    return [];
  }
  const reader = await readerOf(env, personId, reach);
  const keys = [
    ...new Map(asked.map((key) => [versionKeyOf(key), key] as const)).values(),
  ];
  const inShared = await readableIn(brain(env), reader, keys);
  const shared = new Set(inShared.map((key) => versionKeyOf(key)));
  const rest = keys.filter((key) => !shared.has(versionKeyOf(key)));
  const own = ownBrainOf(env, reader);
  const inOwn =
    rest.length === 0 || own === undefined
      ? []
      : await ownOr(async () => await readableIn(own, reader, rest), []);
  const kept = new Set([...shared, ...inOwn.map((key) => versionKeyOf(key))]);
  const seen = new Set<string>();
  // `asked` is `versions` checked, at the same places.
  return versions.filter((_, at) => {
    const ask = asked[at];
    const key = ask === undefined ? undefined : versionKeyOf(ask);
    if (key === undefined || !kept.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/** Who may read Grasp's skills: every current member. */
const skillAccess: Access = { kind: "audience", group: companyGroup };

/**
 * The group a retired shared skill's last version is readable by: core
 * counts no reader in it (`skillReaderOf`, `readerOf`), so nobody lists,
 * selects or reads a retired skill, and its versions stay in the store as
 * history. Only core's reconciler reads with it (`decisionsReaderOf`),
 * answering versions, never text.
 */
const retiredGroup = "retired-skills";

/** The keys of a person's own skills, in their own store, start with this. */
const ownSkillPrefix = `${skillsKind}:person:`;

/**
 * The release's own reader of skills, to compare what is stored with what
 * it ships: the company's group, which every skill is readable by, and a
 * person no member is (core's person principals are user IDs, which never
 * hold ":"), so it reads nothing but what the company may.
 */
const releaseReader: PersonReader = {
  person: "grasp:release",
  groups: [companyGroup],
};

/** The names of Grasp's skills this release ships: the only ones it adds. */
const shippedNames: ReadonlySet<string> = new Set(
  shippedSkills.map(({ name }) => name)
);

/** `text` checked as a skill named `name`: `skills.invalid` when it isn't. */
const skillTextOf = (name: string, text: unknown): string => {
  const checkedText = skillErrors.parse(
    "skills.invalid",
    instructionsTextSchema,
    text
  );
  // Its card names it, and what it says it needs is the format's
  // (skill-needs.ts): a declaration that can't be read is refused here,
  // never read later as needing nothing.
  if (
    skillCardOf(checkedText)?.name !== name ||
    skillNeedsOf(checkedText) === null
  ) {
    throw skillErrors.create("skills.invalid");
  }
  return checkedText;
};

/**
 * Adds `text` as the next version of the Grasp skill `name`, one this
 * release ships, readable by every member, unless it is the skill's
 * current text already (`changed` false, and nothing written); the one
 * before stays as history. `change` is as `addSource`'s. Refused
 * (`skills.invalid`) for a name the release doesn't ship, and when the
 * text isn't a skill named `name` in the Agent Skills format (what it
 * needs, if it says, included) or is over `instructionsMaxLength` UTF-16
 * units, an instruction file's limit: both fail the same way every time,
 * until another release. Two adds at once may both say `changed`; the
 * store still keeps one version per text in a row.
 *
 * Grasp's own skills only: the release's install (brain-skills.ts) is its
 * one caller. Nothing here adds a shared skill: that write needs its own
 * authorization and audit (`writeSharedSkill`).
 */
export const addShippedSkill = async (
  env: BrainEnv,
  added: { name: string; change: string; text: string }
): Promise<SkillAt & { changed: boolean }> => {
  const { name, change } = skillErrors.parse(
    "skills.invalid",
    z.strictObject({
      name: skillNameSchema,
      change: changeSchema,
      text: z.string(),
    }),
    added
  );
  if (!shippedNames.has(name)) {
    throw skillErrors.create("skills.invalid");
  }
  const text = skillTextOf(name, added.text);
  const skill: Skill = { scope: "grasp", name };
  const source = skillKeyOf(skill);
  const [current] = await brain(env).readCurrent({
    sources: [source],
    reader: releaseReader,
  });
  if (current?.text === text) {
    return { ...skill, version: current.version, changed: false };
  }
  const { version } = await whileNotRestoring(
    async () =>
      await brain(env).addInstructions({
        source,
        change,
        text,
        access: skillAccess,
      })
  );
  return { ...skill, version, changed: true };
};

/**
 * Most of the company's skills, and of the teams' a reader is in, a
 * listing answers of each: past them, the ones whose current version is
 * oldest are left out. Far more than a company writes.
 */
const sharedSkillsMax = 10 * listPageMax;

/** The isolate's skill cards (skill-cards.ts). */
const cards = skillCards;

const cardKeyOf = (source: SourceId, version: number): string =>
  `${source}\u0000${version}`;

/**
 * Keeps `card` as the card of `source` at `version` in the shared cache,
 * emptying it first when full. A response holds the cards it needs in a
 * map of its own, so emptying the cache never takes one from it.
 */
const keepCard = (
  source: SourceId,
  version: number,
  card: SkillCardText | null
): void => {
  if (cards.size >= skillCardsKept) {
    cards.clear();
  }
  cards.set(cardKeyOf(source, version), card);
};

/**
 * The card `text` declares, with what it needs, if it is the one `source`
 * names and its needs are the format's: otherwise none, and the skill is
 * listed nowhere.
 */
const declaredCard = (source: SourceId, text: string): SkillCardText | null => {
  const card = skillCardOf(text);
  const needs = skillNeedsOf(text);
  return card !== null &&
    needs !== null &&
    card.name === skillOfKey(source)?.name
    ? { description: card.description, needs }
    : null;
};

/** `source` at `version` as a listing gives it, with its card, if it has one. */
const listedOf = (
  source: SourceId,
  version: number,
  card: SkillCardText | null | undefined
): SkillListed[] => {
  const skill = skillOfKey(source);
  return skill === null || card === undefined || card === null
    ? []
    : [{ ...skill, version, description: card.description, needs: card.needs }];
};

/**
 * `personId` as a reader of skills (`skillReaderOf`), and the names of the
 * teams it reads as, by their IDs: what a listing names each team's skill
 * by.
 */
const skillReaderWithTeamsOf = async (
  env: Pick<Env, "DB">,
  personId: string,
  reach: Reach
): Promise<{
  reader: PersonReader;
  teamNames: ReadonlyMap<string, string>;
}> => {
  const member = await memberOf(env.DB, checked(idSchema, personId));
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  const teams = reach === "company" ? [] : member.teams;
  return {
    reader: {
      person: member.userId,
      groups: [...teams.map(({ id }) => teamGroup(id)), companyGroup],
    },
    teamNames: new Map(teams.map(({ id, name }) => [id, name])),
  };
};

/**
 * `personId` as a reader of skills, as far as `reach` goes (`Reach`): the
 * person, with their teams as core counts them now and the company; or,
 * at the company's reach, the person and the company alone, so no team's
 * skill is ever read. The person is named either way, for their own
 * store, which is addressed only at the person's reach. Refused once they
 * have no current membership.
 */
const skillReaderOf = async (
  env: Pick<Env, "DB">,
  personId: string,
  reach: Reach
): Promise<PersonReader> => {
  const { reader } = await skillReaderWithTeamsOf(env, personId, reach);
  return reader;
};

/** The current versions of `sources`, whole, a batch at a time, in order. */
const readEachCurrent = async (
  store: Brain,
  reader: Reader,
  sources: readonly SourceId[]
) => {
  const read: Awaited<ReturnType<Brain["readCurrent"]>> = [];
  for (let at = 0; at < sources.length; at += currentReadMax) {
    // oxlint-disable-next-line no-await-in-loop -- a few batches, in order
    const batch = await store.readCurrent({
      sources: sources.slice(at, at + currentReadMax),
      reader,
    });
    read.push(...batch);
  }
  return read;
};

/**
 * The shared skills under `prefix` (the company's, or the teams') that
 * `reader` may read, as the store filters them by the reader's groups in
 * its own statement, newest first, at most `sharedSkillsMax`, with their
 * cards: those read before, the rest read now. A version replaced between
 * the listing and the read is left out, as if listed a moment later.
 */
const sharedSkillsAs = async (
  env: BrainEnv,
  reader: Reader,
  prefix: string
): Promise<SkillListed[]> => {
  const listed: { source: SourceId; version: number }[] = [];
  let after: { addedAt: Date; source: SourceId } | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, in order
    const page = await brain(env).listSources({
      reader,
      prefixes: [prefix],
      after,
      limit: listPageMax,
    });
    listed.push(...page.sources);
    const last = page.sources.at(-1);
    after =
      page.more && last !== undefined
        ? { addedAt: last.addedAt, source: last.source }
        : undefined;
  } while (after !== undefined && listed.length < sharedSkillsMax);
  const kept = listed.slice(0, sharedSkillsMax);
  // This response's cards, held here: those cached now, then those read.
  // The shared cache may be emptied as they are kept (`keepCard`), so the
  // response never reads from it after this.
  const known = new Map<string, SkillCardText | null>();
  for (const { source, version } of kept) {
    const key = cardKeyOf(source, version);
    const card = cards.get(key);
    if (card !== undefined) {
      known.set(key, card);
    }
  }
  const read = await readEachCurrent(
    brain(env),
    reader,
    kept
      .filter(({ source, version }) => !known.has(cardKeyOf(source, version)))
      .map(({ source }) => source)
  );
  for (const { source, version, text } of read) {
    const card = declaredCard(source, text);
    known.set(cardKeyOf(source, version), card);
    keepCard(source, version, card);
  }
  return kept.flatMap(({ source, version }) =>
    listedOf(source, version, known.get(cardKeyOf(source, version)))
  );
};

/**
 * `reader`'s own skills, from their own store, at their current versions,
 * with their cards, newest first, every page of them: read whole each
 * time, never from the cards kept, whose keys name no person.
 */
const ownSkillsAs = async (
  env: BrainEnv,
  reader: PersonReader
): Promise<SkillListed[]> => {
  const store = ownBrain(env, reader.person);
  const listed: SourceId[] = [];
  let after: { addedAt: Date; source: SourceId } | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, in order
    const page = await store.listSources({
      reader,
      prefixes: [ownSkillPrefix],
      after,
      limit: listPageMax,
    });
    listed.push(...page.sources.map(({ source }) => source));
    const last = page.sources.at(-1);
    after =
      page.more && last !== undefined
        ? { addedAt: last.addedAt, source: last.source }
        : undefined;
  } while (after !== undefined);
  const read = await readEachCurrent(store, reader, listed);
  return read.flatMap(({ source, version, text }) =>
    listedOf(source, version, declaredCard(source, text))
  );
};

/**
 * Every skill `personId` may read, as far as `reach` goes (`Reach`), at
 * its current version, with its description and what it needs: Grasp's
 * by the names in `shipped` (this release's), read by name, so however
 * long ago they were installed; the company's, and, beyond the company's
 * reach, their teams' (as the store filters them by the teams core counts
 * them in now), each listed on its own, newest first, at most
 * `sharedSkillsMax`; and, at the person's reach alone, their own, from
 * their own store, which is otherwise never addressed (only where what
 * the skills shape reaches the person alone: their own chat, their own
 * page). Those that declare their own name only. Every one, whatever
 * else has its name: which of one name takes the place of another, and
 * whose needs are met, is brain-skills.ts's to decide. Refused with
 * `permission.person_inactive` once they are no longer a member.
 */
export const listSkillsAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  shipped: ReadonlySet<string>,
  { reach }: { reach: Reach }
): Promise<SkillListed[]> => {
  const { reader, teamNames } = await skillReaderWithTeamsOf(
    env,
    personId,
    reach
  );
  const company = await sharedSkillsAs(env, reader, `${skillsKind}:company:`);
  const listedTeams =
    reach === "company"
      ? []
      : await sharedSkillsAs(env, reader, teamSkillPrefix);
  // Each named as the reader's team: only theirs are listed.
  const teams = listedTeams.map((skill) =>
    skill.scope === "team"
      ? { ...skill, teamName: teamNames.get(skill.team) ?? skill.team }
      : skill
  );
  const graspSources = [...shipped].flatMap((name) => {
    const skill = skillSchema.safeParse({ scope: "grasp", name });
    return skill.success ? [skillKeyOf(skill.data)] : [];
  });
  const graspRead = await readEachCurrent(brain(env), reader, graspSources);
  const grasp = graspRead.flatMap(({ source, version, text }) => {
    // Read now, so its card is held here before the cache is touched.
    const card =
      cards.get(cardKeyOf(source, version)) ?? declaredCard(source, text);
    keepCard(source, version, card);
    return listedOf(source, version, card);
  });
  // Their own part may go missing when their store fails, never the
  // shared part (`ownOr`).
  const own =
    reach === "person"
      ? await ownOr(async () => await ownSkillsAs(env, reader), [])
      : [];
  return [...grasp, ...company, ...teams, ...own];
};

/** The store `skill` is in for `reader`: their own for their own skills. */
const skillStoreOf = (
  env: BrainEnv,
  reader: PersonReader,
  { scope }: Skill
): Brain => (scope === "person" ? ownBrain(env, reader.person) : brain(env));

/**
 * `skill` at its version, whole, for `personId`, as far as `reach` goes,
 * current or history while they may read its current version (as
 * `readSourceVersionAs`): `null` when there is none, alike. A `person`
 * skill is only ever theirs, and only at the person's reach: their own
 * store is the only one asked, so another person's answers as one that
 * doesn't exist. A team's skill only for its members, beyond the
 * company's reach. Refused with `skills.invalid` for something that isn't
 * a skill at a version, and `permission.person_inactive` once they are no
 * longer a member, whatever is asked.
 */
export const readSkillAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: SkillAt,
  { reach }: { reach: Reach }
): Promise<SkillVersion | null> => {
  const { version, ...skill } = skillErrors.parse(
    "skills.invalid",
    skillAtSchema,
    wanted
  );
  const reader = await skillReaderOf(env, personId, reach);
  if (skill.scope === "person" && reach !== "person") {
    // Their own store is never addressed short of the person's reach.
    return null;
  }
  const read = await skillStoreOf(env, reader, skill).readVersion({
    source: skillKeyOf(skill),
    version,
    reader,
  });
  return read === null ? null : { ...skill, version, text: read.text };
};

/**
 * `skill` at its current version, whole, for `personId`, as `readSkillAs`
 * reads it at the person's reach: `null` when there is none they may read.
 */
export const readCurrentSkillAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: Skill
): Promise<SkillVersion | null> => {
  const skill = skillErrors.parse("skills.invalid", skillSchema, wanted);
  const reader = await skillReaderOf(env, personId, "person");
  const [current] = await skillStoreOf(env, reader, skill).readCurrent({
    sources: [skillKeyOf(skill)],
    reader,
  });
  return current === undefined
    ? null
    : { ...skill, version: current.version, text: current.text };
};

/**
 * Whom a shared skill is for: every member (`company`), or one team's
 * members (`team`). Stored by core (skill-shares.ts) as the Brain's own
 * name of that group (`audienceKeyOf`), and read back only through
 * `audienceOf`, which never takes a missing or malformed one for the
 * company.
 */
export type SkillAudience =
  | { kind: "company" }
  | { kind: "team"; team: string };

const audienceSchema = z.union([
  z.strictObject({ kind: z.literal("company") }),
  z.strictObject({ kind: z.literal("team"), team: idSchema }),
]);

/** The group `audience` reads as, which is also how core stores it. */
export const audienceKeyOf = (audience: SkillAudience): string => {
  const checkedAudience = skillErrors.parse(
    "skills.invalid",
    audienceSchema,
    audience
  );
  return checkedAudience.kind === "company"
    ? companyGroup
    : teamGroup(checkedAudience.team);
};

/**
 * `stored` (`audienceKeyOf`) as the audience it names, or null for
 * anything else, a missing one among them: never the company unless it
 * says so.
 */
export const audienceOf = (stored: unknown): SkillAudience | null => {
  if (stored === companyGroup) {
    return { kind: "company" };
  }
  if (typeof stored !== "string" || !stored.startsWith(teamPrefix)) {
    return null;
  }
  const team = idSchema.safeParse(stored.slice(teamPrefix.length));
  return team.success ? { kind: "team", team: team.data } : null;
};

/** The shared skill `name` for `audience`, as the skill a reader names. */
const sharedSkillOf = (audience: SkillAudience, name: string): Skill =>
  skillErrors.parse(
    "skills.invalid",
    skillSchema,
    audience.kind === "company"
      ? { scope: "company", name }
      : { scope: "team", team: audience.team, name }
  );

/**
 * Core's own reader of `audience`'s skills, live and retired, for the
 * reconciler (skill-shares.ts): the release's person, which no member is,
 * so it acts for nobody; it reads versions alone, never answering text.
 */
const decisionsReaderOf = (audience: SkillAudience): Reader => ({
  person: releaseReader.person,
  groups: [audienceKeyOf(audience), retiredGroup],
});

/**
 * The current version of `audience`'s skill `name`, live or retired; null
 * while it has none. What the reconciler writes over (`after`).
 */
export const sharedSkillVersion = async (
  env: BrainEnv,
  { audience, name }: { audience: SkillAudience; name: string }
): Promise<number | null> => {
  // The newest version listed, live or retired, is the current one: read
  // without its text, which nothing here needs.
  const { versions } = await brain(env).listVersions({
    source: skillKeyOf(sharedSkillOf(audience, name)),
    reader: decisionsReaderOf(audience),
    limit: 1,
  });
  return versions[0]?.version ?? null;
};

/**
 * The version of `audience`'s skill `name` its change `change` made, live
 * or retired, if it made one: a number alone, never text. How the
 * reconciler learns what a decision did in the Brain, whether or not a
 * reply ever came back.
 */
export const sharedChangeVersion = async (
  env: BrainEnv,
  asked: { audience: SkillAudience; name: string; change: string }
): Promise<number | null> =>
  await brain(env).changeVersion({
    source: skillKeyOf(sharedSkillOf(asked.audience, asked.name)),
    change: skillErrors.parse("skills.invalid", changeSchema, asked.change),
    reader: decisionsReaderOf(asked.audience),
  });

/**
 * Writes `audience`'s skill `name` as a decision says (skill-shares.ts):
 * `text` as its next version, readable by the audience's members (every
 * member, or the team's), or `retired`, readable by no one (its versions
 * stay as history). Under `change`, the decision's own, so a retry writes
 * nothing twice (the store answers a change it has with the version it
 * made, first); and only while the current version is still `after`
 * (`sharedSkillVersion`, null for none), checked in the store's own
 * transaction: otherwise `stale`, and nothing written. Answers the
 * version it made.
 *
 * Who may decide is checked where the decision is written, in core's
 * database; this only writes what a recorded decision says. The one way
 * a shared skill is written.
 */
export const writeSharedSkill = async (
  env: BrainEnv,
  written: {
    audience: SkillAudience;
    name: string;
    change: string;
    text: string;
    retired: boolean;
    after: number | null;
  }
): Promise<number | "stale"> => {
  const source = skillKeyOf(sharedSkillOf(written.audience, written.name));
  try {
    const { version } = await brain(env).addInstructions({
      source,
      change: skillErrors.parse("skills.invalid", changeSchema, written.change),
      text: skillTextOf(written.name, written.text),
      access: {
        kind: "audience",
        group: written.retired ? retiredGroup : audienceKeyOf(written.audience),
      },
      after: written.after,
    });
    return version;
  } catch (error) {
    if (error instanceof Error && error.message === staleVersion) {
      return "stale";
    }
    throw error;
  }
};

/**
 * Adds `text` as the next version of the member `personId`'s own skill of
 * the name its frontmatter gives, in their own store (`keptIn`, with
 * `owner` access), readable by them alone; the one before stays as
 * history. `change` as `writeSharedSkill`'s. Refused (`skills.invalid`)
 * for text that isn't a skill (what it needs, if it says, included),
 * (`skills.name_erased`) for a name of theirs they erased, and
 * `permission.person_inactive` once they are no longer a member.
 */
export const addOwnSkill = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  added: { change: string; text: string }
): Promise<SkillAt> => {
  const reader = await skillReaderOf(env, personId, "person");
  const change = skillErrors.parse(
    "skills.invalid",
    changeSchema,
    added.change
  );
  const name = skillCardOf(
    skillErrors.parse("skills.invalid", instructionsTextSchema, added.text)
  )?.name;
  if (name === undefined) {
    throw skillErrors.create("skills.invalid");
  }
  const text = skillTextOf(name, added.text);
  const skill = { scope: "person", name } as const;
  const key = skillKeyOf(skill);
  const access: Access = { kind: "owner", person: reader.person };
  // A name they erased stays erased for good (`eraseOwnSkill`): its key
  // is closed, so a pin of one of its versions never means other text.
  if ((await ownBrain(env, reader.person).keyState(key)) === "erased") {
    throw skillErrors.create("skills.name_erased");
  }
  const { version } = await keptIn(
    env,
    key,
    access,
    async (store) =>
      await store.addInstructions({ source: key, change, text, access })
  );
  return { ...skill, version };
};

/**
 * Erases the member `personId`'s own skill `name` for good, every version,
 * from their own store; its key is closed there, as `eraseSource` closes
 * one. Answers alike whether they had it. Safe to repeat; a call that
 * failed must be repeated until it returns, as `eraseSource`'s. Refused
 * once they are no longer a member (an erasure of the person erases their
 * whole store: `erasePerson`).
 *
 * The one erasure from an own store not closed in the shared ledger
 * (`erasedFromOwnStore`): a person's skill's key (`skill:person:<name>`)
 * names no person, so every member's skill of that name has the same key,
 * and closing it there would make staff's lookup of that key answer
 * erased for anyone's, once one member deleted theirs, and tell staff
 * that someone had a skill of that name. Staff's lookup answers "not
 * erased" for it, with its hedge.
 */
export const eraseOwnSkill = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  name: string
): Promise<void> => {
  const { person } = await skillReaderOf(env, personId, "person");
  const skill = skillErrors.parse("skills.invalid", skillSchema, {
    scope: "person",
    name,
  });
  await ownBrain(env, person).eraseSource({
    source: skillKeyOf(skill),
    reason: "deleted",
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
  async ({ purpose, role, system, input, timeoutMs }) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const { text } = await models(env).call({
        model: modelForRole(await modelSettings(env), role),
        // A check asks the quick model to think little: the cheaper call.
        ...(role === "quick" ? { effort: "low" as const } : {}),
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
 * The context window of the models the Brain's work asks, in tokens: the
 * smaller of the careful and the quick one's, from the gateway's catalog;
 * null when either is an OpenAI-compatible endpoint's (the catalog gives
 * such a model a window it doesn't know), or no model is set up (the
 * calls then fail as the account's trouble). Null means a version is read
 * as one piece: a model whose window it overflows refuses the call, and
 * the item parks.
 */
const contextTokensOf = async (env: Env): Promise<number | null> => {
  let settings: Awaited<ReturnType<typeof modelSettings>>;
  try {
    settings = await modelSettings(env);
  } catch {
    return null;
  }
  const windows = brainModelRoles.map((role) => {
    try {
      const ref = parseModelRef(modelForRole(settings, role));
      if (ref === undefined || ref.provider === "openai-compatible") {
        return null;
      }
      const window = ref.catalog.contextWindow;
      return window > 0 ? window : null;
    } catch {
      return null;
    }
  });
  return windows.every((window) => window !== null)
    ? Math.min(...windows)
    : null;
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

// Hand-overs: what core produces reaches the Brain through its work
// queue (the contract's `handOver`). Core notes what to hand over from the
// audit events of its changes (brain-hand-overs.ts), and the clock relays
// it to the queue by key alone (brain-sources.ts `relayHandOvers`, through
// `queueHandOvers`); the queue's item asks core's producers for the source
// as their records hold it when it runs (brain-sources.ts `producersOf`,
// given to `workBrain`), and every way it ends is recorded here, the same
// for every producer: added, refused or skipped, with why. The readers are
// checked here as an add's (`sourceReadersSchema`): a producer that names
// none is refused, and nothing is added.

/**
 * A source as its producer holds it now: its change, text and readers,
 * and the text to keep instead when `text` is past a source's bound
 * (`whenTooLarge`: what it is, saying plainly that the rest was too large
 * to keep, never a cut part of it); or nothing to hand over (`gone`), and
 * why; or nothing, as the erasure of its one reader (`readers`, the store
 * that may hold it) has begun, when the Brain closes its key, as an add of
 * it may have landed after that erasure.
 */
export type Handed =
  | { kind: "gone"; skipped: HandOverSkip }
  | { kind: "erased"; readers: SourceReaders }
  | {
      kind: "source";
      change: string;
      text: string;
      whenTooLarge: string;
      readers: SourceReaders;
      /** The group it is added in (`addSource`): none for most. */
      group?: SourceRef;
    };

/**
 * Why a noted source is not handed over after all, one of a fixed set:
 * its record restricted since, deleted or gone, its details past their
 * retention, its reader no longer a member, or nothing of it to keep (a
 * question of no words).
 */
export type HandOverSkip =
  | "restricted"
  | "deleted"
  | "past_retention"
  | "not_a_member"
  | "no_text";

/** How a hand-over that did something ended: added, or refused for good. */
export type HandOverEnd = Exclude<HandOverResult, { kind: "nothing" }>;

/** How a hand-over ended: added, refused for good, or skipped with why. */
export type HandOverOutcome =
  | HandOverEnd
  | { kind: "skipped"; reason: HandOverSkip };

/**
 * One attempt at a hand-over, as its producer answers it: the source as
 * its records hold it now, and the records of the one noted hand-over
 * this attempt may end, read before the source was.
 */
export interface HandOverAttempt {
  handed: Handed;
  /**
   * Records that the source's text leaves core now, if its noted hand-over
   * is still open as this attempt read it: false when it is not (an
   * earlier attempt ended it, its answer lost; or it was noted anew,
   * which a later item hands over), and then nothing may leave.
   */
  started: () => Promise<boolean>;
  /**
   * Records how it ended and ends its noted hand-over, both or neither:
   * nothing when that is not open as this attempt read it, so a noted
   * hand-over ends in exactly one outcome. Throws when it can't, so the
   * item is tried again.
   */
  ended: (outcome: HandOverOutcome) => Promise<void>;
}

/** Core's producers, as the Brain's hand-overs reach them (brain-sources.ts). */
export interface Producers {
  /** Begins an attempt at handing `source` over. */
  attempt: (source: SourceRef) => Promise<HandOverAttempt>;
}

/** The class of the Brain's work every hand-over takes. */
const handOverPriority: HandOverPriority = "conversation";

/**
 * Closes `source`'s key for good, as the erasure of its one reader
 * (`readers`) has begun: the Brain's `eraseSource`, from the store
 * `readers` say holds it.
 */
const closeKey = async (
  env: BrainEnv,
  source: SourceRef,
  readers: SourceReaders
): Promise<void> => {
  await eraseSource(env, {
    source,
    readers: checked(sourceReadersSchema, readers),
    reason: "person_erased",
  });
};

/** Whether `error` is core's refusal of an add an erasure closed (`addSource`). */
const isErasedRefusal = (error: unknown): boolean =>
  brainSourceErrors.codeOf(error) === "brain.source_erased";

/**
 * Refuses the hand-over `attempt` is at for `reason`: recorded first,
 * then, when its one reader's erasure began (`closing`), its key closed.
 * In that order, as closing the key takes this item off the queue with
 * every other of its key: a refusal recorded after could, failing, never
 * be tried again. A close that fails fails the item, which is tried again
 * and closes it then, its refusal recorded once.
 */
const refuse = async (
  env: Env,
  attempt: HandOverAttempt,
  source: SourceRef,
  reason: HandOverEnd & { kind: "refused" },
  closing?: SourceReaders
): Promise<HandOverResult> => {
  await attempt.ended(reason);
  if (closing !== undefined) {
    await closeKey(env, source, closing);
  }
  return reason;
};

/**
 * Hands `source` over as its producer's records hold it now, through
 * `addSource`, which takes it to the store its readers belong in, and says
 * how it ended (`HandOverResult`), which settles the item as done:
 *
 * - nothing, when the producer has nothing to hand over: skipped, with
 *   its producer's reason;
 * - refused as `invalid`, when the producer's answer can't be added (no
 *   readers, a text that isn't one): never tried again;
 * - its text, or its `whenTooLarge` when the text is past a source's
 *   bound as given or as indexed (`fitsSourceText`); refused as
 *   `too_large` when neither fits;
 * - refused as `erased` when what it adds was erased: final.
 *
 * Each records its outcome, which ends the noted hand-over: once, as a
 * repeat of an attempt that ended it records nothing (`HandOverAttempt`).
 *
 * A source for one person alone whose erasure has begun is erased (its key
 * closed), never left: when the producer says so (`erased`), as an add of
 * it may have landed after the Brain's erasure (began before it, the add's
 * erasure failed or never ran), and when it was added while that erasure
 * began (core's record of it is written before the Brain's erasure, and
 * the producer checked it before the add). Only a throw tries it again: a
 * store out of reach, an audit write or a close that failed.
 */
const handOver = async (
  env: Env,
  producers: Producers,
  source: SourceRef
): Promise<HandOverResult> => {
  const attempt = await producers.attempt(source);
  const { handed } = attempt;
  if (handed.kind === "gone") {
    await attempt.ended({ kind: "skipped", reason: handed.skipped });
    return { kind: "nothing" };
  }
  const refused = async (
    reason: (HandOverEnd & { kind: "refused" })["reason"],
    closing?: SourceReaders
  ) => await refuse(env, attempt, source, { kind: "refused", reason }, closing);
  if (handed.kind === "erased") {
    return await refused("erased", handed.readers);
  }
  const readers = sourceReadersSchema.safeParse(handed.readers);
  const texts = [handed.text, handed.whenTooLarge].filter(
    (text) => wellFormedString().safeParse(text).success
  );
  if (!readers.success || texts.length < 2) {
    return await refused("invalid");
  }
  const text = texts.find((each) => fitsSourceText(each));
  if (text === undefined) {
    return await refused("too_large");
  }
  if (!(await attempt.started())) {
    return { kind: "nothing" };
  }
  let version: number;
  try {
    ({ version } = await addSource(env, {
      source,
      change: handed.change,
      text,
      readers: readers.data,
      ...(handed.group === undefined ? {} : { group: handed.group }),
    }));
  } catch (error) {
    if (!isErasedRefusal(error)) {
      throw error;
    }
    return await refused("erased");
  }
  if (
    readers.data.kind === "owner" &&
    (await erasureBegun(env, readers.data.personId))
  ) {
    return await refused("erased", readers.data);
  }
  const added: HandOverResult = { kind: "added", version };
  await attempt.ended(added);
  return added;
};

/** Core's producers as the Brain's work reaches them, by its keys. */
const handOversOf = (env: Env, producers: Producers): HandOvers => ({
  handOver: async (key) => await handOver(env, producers, sourceRefOf(key)),
});

/**
 * Puts `sources` on the shared store's work queue to be handed over, each
 * in place of one of its hand-overs still waiting or parked: their keys
 * alone, as what is added is what its producer answers when the item runs
 * (`workBrain`). One the Brain can't key (too long, a control character)
 * never will be: left out and counted in the log, never named, as an id
 * can echo what a person typed. Returns those it left out, as given. Sent
 * `handOversMax` at a time, one call after the other: a call that fails
 * leaves those after it unsent.
 */
export const queueHandOvers = async (
  env: BrainEnv,
  sources: readonly SourceRef[]
): Promise<SourceRef[]> => {
  const items: HandOverRequest["items"] = [];
  const unkeyable: SourceRef[] = [];
  for (const each of sources) {
    const source = sourceRefSchema.safeParse(each);
    if (source.success) {
      items.push({
        source: sourceKeyOf(source.data),
        priority: handOverPriority,
      });
    } else {
      unkeyable.push(each);
    }
  }
  if (unkeyable.length > 0) {
    log.warn("brain.hand_over.unkeyed", { count: unkeyable.length });
  }
  for (let at = 0; at < items.length; at += handOversMax) {
    // oxlint-disable-next-line no-await-in-loop -- one call after the other
    await brain(env).handOver({ items: items.slice(at, at + handOversMax) });
  }
  return unkeyable;
};

/**
 * One tick of the Brain's background work at `at`, the time core's clock
 * runs it: the store sweeps what adds that never finished left, repacks a
 * few blocks of vector codes, keeps its vectors to core's embedding model,
 * then runs what is due in its queue, its model calls through core's
 * gateway, its passages through core's bulk embedders and its hand-overs
 * through `producers`: core's (brain-sources.ts `producersOf`), which the
 * clock gives. Required, so no tick of the shared store forgets them; a
 * tick that hands nothing over says so with producers that read nothing.
 * Harmless late or twice.
 */
export const workBrain = async (
  env: Env,
  at: Date,
  producers: Producers
): Promise<void> => {
  await brain(env).work({
    ask: askModel(env),
    at,
    embedders: await embeddersOf(env),
    handOvers: handOversOf(env, producers),
    contextTokens: await contextTokensOf(env),
  });
};

/**
 * What a person's own store tells core of itself as its tick ends
 * (brain-own-stores.ts): numbers and flags, from its overview, field by
 * field. Nothing that names anything: no item's kind, key, error or
 * words, and no size, only whether it is near its limit.
 */
const healthOf = (overview: WorkOverview, at: Date): OwnStoreHealth => {
  let waiting = 0;
  let oldest: number | null = null;
  for (const { count, oldestAddedAt } of overview.waiting) {
    waiting += count;
    const added = oldestAddedAt.getTime();
    oldest = oldest === null ? added : Math.min(oldest, added);
  }
  return {
    reportedAt: at,
    waiting,
    oldestWaitingAt: oldest === null ? null : new Date(oldest),
    parked: overview.parkedCount,
    failing:
      overview.paused !== null ||
      overview.ledgerReplay !== "through" ||
      Object.values(overview.stepsFailed).some((failure) => failure !== null),
    notRebuilt:
      overview.embedding.model !== null && !overview.embedding.rebuilt,
    nearLimit: storeNearLimit({
      bytes: overview.storeBytes,
      limitBytes: storeBytesMax,
    }),
  };
};

/**
 * What the store named `name` works with on its own alarm (core's
 * BrainStore, brain-store.ts), when it is a person's own: core's model
 * gateway and embedders, as the clock gives the shared store's tick
 * (`workBrain`), and its health row kept for staff's totals. No
 * hand-overs: a person's own store never queues one. Only the store
 * itself asks, inside its own object, by its own name: so it works for
 * no one but its person, and its row is its own.
 */
export const alarmHostOf = async (
  env: Env,
  name: string | undefined
): Promise<{
  ask: AskModel;
  embedders: Embedders;
  contextTokens: number | null;
  report: (overview: WorkOverview) => Promise<void>;
}> => {
  const kind = storeKindOf(name);
  if (kind.kind !== "person") {
    throw new Error("Only a person's own store works on its own alarm");
  }
  return {
    ask: askModel(env),
    embedders: await embeddersOf(env),
    // What extraction cuts the person's own sources to, as the shared
    // store's tick does (`workBrain`).
    contextTokens: await contextTokensOf(env),
    report: async (overview) => {
      const at = new Date();
      try {
        // A store that holds nothing any more (erasures took it all) has
        // no row: staff's count is of stores that hold anything. One
        // whose ledger isn't read through shows nothing of what it holds,
        // so it keeps its row, as failing.
        await (overview.ledgerReplay === "through" && !overview.holding
          ? forgetOwnStoreHealth(env, kind.person, at)
          : keepOwnStoreHealth(env, kind.person, healthOf(overview, at)));
      } catch {
        // Stale until the next tick: logged by a fixed name alone.
        log.warn("brain.own_store_health_unkept", {});
      }
    },
  };
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
 * Erasures are counts alone: never which, when, or by what hash. What
 * its model calls spent this month comes from the gateway's records, by
 * purpose alone.
 */
export const brainStaffReport = async (
  env: BrainEnv & Pick<Env, "DB" | "SPEND_MONTH">
): Promise<
  BrainReport & Required<Pick<BrainReport, "ownStores" | "modelSpend">>
> => {
  const [overview, own, modelSpend] = await Promise.all([
    brain(env).workOverview(),
    ownStoresTotals(env),
    brainSpendByPurpose(env, spendMonth(env)),
  ]);
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
    ownStores: {
      ...own,
      oldestWaitingAt: own.oldestWaitingAt?.toISOString() ?? null,
    },
    modelSpend,
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

/**
 * Whether what Grasp's staff named (brain-report.ts) is erased, as the
 * Brain's shared store's record of its ledger says: a source, by the
 * Brain's key for it, or a person, by their id, each hashed by the store
 * as its ledger names it. The answer is the store's alone, field by field:
 * a state, and for `erased` when. Never a person's own store: a staff path
 * addresses no personal object (GRA-1762), so a person's erasure is read
 * with core's own record of it (brain-report.ts). A source's answer is the
 * shared ledger's alone: that its key was closed there. `eraseSource`
 * closes a source its owner keeps in their own store there first, hidden
 * and recorded in that store's ledger, and in the shared store only once
 * that returned, so the shared ledger never says erased while a copy can
 * still be read or come back after a restore. That store's hidden rows
 * are deleted by its own next tick, which this answer doesn't wait for:
 * staff name a source by its key alone, and no staff path addresses a
 * person's own store to ask.
 */
export const brainErasureForStaff = async (
  env: BrainEnv,
  lookup: BrainErasureLookup
): Promise<BrainErasureAnswer> => {
  const status = await brain(env).erasureStatus(
    lookup.kind === "source"
      ? { kind: "source", source: lookup.key }
      : { kind: "person", person: lookup.id }
  );
  return status.state === "erased"
    ? { state: "erased", at: status.at.toISOString() }
    : { state: status.state };
};

// Memories, for a person core verified (GRA-1743): what a person's own
// chat saves of what they said (agent-remember.ts, through
// brain-memories.ts), and their undo. Everything written here is the
// person's own word (writer and speaker both them), readable by them
// alone, and kept in their own store (`person:<id>`), never in the shared
// one: the plan's rule is that a memory an agent writes is readable only
// by those who can read everything its chat read, and a person's own chat
// read only what they may. An instruction is the Brain's to keep its
// writer's own (`owner` of that writer), which this is.

/**
 * The attributes a memory a person says can hold, as the Brain lists them:
 * those whose value is a text, never a relation to another entity (which
 * a memory names by the related entity, not a value). No attribute is a
 * relation for one kind and a value for another.
 */
const valueRules = Object.values(entityAttributes).flatMap((rules) =>
  Object.entries(rules).flatMap(([name, rule]: [string, AttributeRule]) =>
    rule.relation === undefined ? [{ name, many: rule.values === "many" }] : []
  )
);
const attributeNames = [...new Set(valueRules.map(({ name }) => name))];

/** Of those, the ones that hold many values side by side. */
const manyValueAttributes = [
  ...new Set(valueRules.flatMap(({ name, many }) => (many ? [name] : []))),
];

/**
 * What a memory a person says may name, as the Brain lists them, and the
 * Brain's own bounds on its texts: for the chat's tool to offer, so the
 * model chooses from these and no other number is invented.
 */
export const memoryChoices = {
  kinds: entityKinds,
  types: memoryTypes,
  attributes: attributeNames,
  manyValueAttributes,
  valueMaxLength,
  statementMaxLength,
  quoteMaxLength,
} as const;

/** A text of a memory: some text, at most `max` characters (the Brain's bounds). */
const memoryText = (max: number) => wellFormedString().regex(/\S/u).max(max);

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

const rememberedSchema = z.strictObject({
  change: changeSchema,
  about: memoryAboutSchema,
  attribute: z.enum(attributeNames).optional(),
  value: memoryText(valueMaxLength).optional(),
  type: z.enum(memoryTypes),
  statement: memoryText(statementMaxLength),
  quote: memoryText(quoteMaxLength),
});

/** A memory a person said, to save for them (`rememberAs`), as its schema takes it. */
export type Remembered = z.input<typeof rememberedSchema>;

/**
 * What `rememberAs` saved: the memory and the entity it is about, and the
 * memory's own fields as the store holds them (`kept`), read back from
 * it: what the person is shown, never what the caller asked for.
 */
export interface RememberedMemory {
  memory: MemoryId;
  entity: EntityId;
  kept: Pick<Memory, "type" | "attribute" | "value" | "statement">;
}

/**
 * `error`, an erased store's or key's refusal (the Brain's own words), as
 * the code core gives it everywhere (`brain.source_erased`): final, never
 * tried again. Any other error as it is.
 */
const erasedAs = (error: unknown): unknown =>
  error instanceof Error &&
  (error.message === erasedSource || error.message === storeErased)
    ? brainSourceErrors.create("brain.source_erased")
    : error;

/**
 * Memory `memory` about `entity` in `store`, as `reader` reads it, history
 * included: every page, read at the first page's moment, until it is
 * found. Undefined when none holds it.
 */
const keptMemory = async (
  store: Brain,
  reader: Reader,
  entity: EntityId,
  memory: MemoryId
): Promise<Memory | undefined> => {
  let after: MemoriesCursor | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await store.readMemories({
      entity,
      reader,
      history: true,
      ...(after === undefined ? {} : { after }),
    });
    const found = page.memories.find(({ id }) => id === memory);
    if (found !== undefined) {
      return found;
    }
    after = page.more ? page.next : undefined;
  } while (after !== undefined);
  return undefined;
};

/**
 * Saves what the member `personId` said as their own memory, readable by
 * them alone, in their own store: about an entity of theirs (by id, as
 * they may see it), or one found by an exact identifier there, or a new
 * one. Their new word on the same entity and one-value attribute ends
 * their earlier memory, which stays as history. `change` names this one
 * save, minted by core (a chat's tool call): the same change again
 * answers what it saved. Refused once they are no longer a member, and by
 * the Brain for what its rules refuse (an attribute their entity's kind
 * doesn't have, say).
 */
export const rememberAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  remembered: Remembered | Readonly<Record<string, unknown>>
): Promise<RememberedMemory> => {
  const { change, about, quote, ...memory } = checked(
    rememberedSchema,
    remembered
  );
  const reader = await personReaderOf(env, personId);
  const { person } = reader;
  const store = ownBrain(env, person);
  let added: Awaited<ReturnType<Brain["addMemories"]>>;
  try {
    added = await store.addMemories({
      change,
      access: { kind: "owner", person },
      // An entity's id is taken only as they may see it.
      reader,
      entities: [{ key: "about", ...about }],
      memories: [
        {
          about: "about",
          ...memory,
          speaker: { kind: "internal", person },
          basis: { kind: "writer", writer: person, quote },
        },
      ],
    });
  } catch (error) {
    throw erasedAs(error);
  }
  const [saved] = added.memories;
  const entity = added.entities.about;
  const kept =
    saved === undefined || entity === undefined
      ? undefined
      : await keptMemory(store, reader, entity, saved);
  if (saved === undefined || entity === undefined || kept === undefined) {
    throw new Error("The Brain kept no memory");
  }
  const { type, attribute, value, statement } = kept;
  return {
    memory: saved,
    entity,
    kept: { type, attribute, value, statement },
  };
};

/** The names and identifiers of `entity` that `reader` may see in `store`, each page read. */
const entityNamesOf = async (
  store: Brain,
  reader: Reader,
  entity: EntityId
): Promise<{ names: string[]; identifiers: Identifier[] }> => {
  const names: string[] = [];
  const identifiers: Identifier[] = [];
  let after: EntityNamesCursor | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await store.readEntityNames({
      entity,
      reader,
      ...(after === undefined ? {} : { after }),
    });
    for (const { type, value } of page.names) {
      if (type === "name") {
        names.push(value);
      } else {
        identifiers.push({ type, value });
      }
    }
    after = page.more ? page.next : undefined;
  } while (after !== undefined);
  return { names, identifiers };
};

/**
 * The exact identifier a person's own entity carries for the shared
 * entity it stands for (`correctAs`): one form, minted here alone, so
 * every correction of that shared entity links to the same entity of
 * theirs. Kept only in their own store, and never shown as one of the
 * entity's identifiers (`ownEntityAs` leaves it out).
 */
const sharedEntityRefPrefix = "grasp:shared-entity:";

/** The identifier of the person's own entity for shared entity `id`. */
const sharedEntityRefOf = (id: EntityId): Identifier => ({
  type: "ref",
  value: `${sharedEntityRefPrefix}${id}`,
});

/** Whether `identifier` is one `sharedEntityRefOf` made. */
const isSharedEntityRef = ({ type, value }: Identifier): boolean =>
  type === "ref" && value.startsWith(sharedEntityRefPrefix);

/**
 * An entity of a person's own store, as they may read it: its kind, the
 * earliest name they may see (`name`), and every name and exact
 * identifier they may see.
 */
export interface OwnEntity {
  kind: EntityKind;
  name: string | null;
  names: string[];
  identifiers: Identifier[];
}

/**
 * The entity `entity` of the member `personId`'s own store, as they may
 * read it: what a memory about it is about, named as the store holds it,
 * every page of its names read at the first page's moment. Null alike
 * when there is none or they may not. Refused once they are no longer a
 * member.
 */
export const ownEntityAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  entity: string
): Promise<OwnEntity | null> => {
  const id = checked(entityIdSchema, entity);
  const reader = await personReaderOf(env, personId);
  const store = ownBrain(env, reader.person);
  const read = await store.readEntity({ entity: id, reader });
  if (read === null) {
    return null;
  }
  const { names, identifiers } = await entityNamesOf(store, reader, id);
  return {
    kind: read.kind,
    name: read.name,
    names,
    // What stands for a shared entity is core's own link, not one of it.
    identifiers: identifiers.filter((each) => !isSharedEntityRef(each)),
  };
};

/**
 * Retires one of the member `personId`'s own memories (`rememberAs`),
 * current or ended by a newer one of theirs: it never becomes current
 * again, and stays as history; `done` again for one they retired before,
 * so a retry never reads as not found. `nothing` alike when there is no
 * such memory (an erased one included), when it isn't theirs, and when it
 * has expired. Refused once they are no longer a member.
 */
export const forgetAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  memory: string
): Promise<MemoryChangeOutcome> => {
  const id = checked(memoryIdSchema, memory);
  const reader = await personReaderOf(env, personId);
  try {
    return await ownBrain(env, reader.person).retireMemory({
      memory: id,
      reader,
    });
  } catch (error) {
    throw erasedAs(error);
  }
};

// The Brain's Memories page (GRA-1746), for a person core verified: the
// entities they may see, what the Brain remembers about one, history
// included, the facts sources disagree on, and their confirmation or
// correction. Each reads as them, from what they may read alone, in the
// store each entity and memory is in: their own (theirs alone) or the
// shared one, whose ids are their own, so each is named with its store.
// A listing reads their own store first, then the shared one, a page of
// one store's at a time, with that store's own place to go on from: what
// they may not read takes no place in a page nor says more follow.

/** Which store: the person's own (theirs alone), or the shared one. */
export type MemoryStoreName = "own" | "shared";

export type {
  ContestedCursor,
  EntitiesCursor,
  MemoriesCursor,
} from "@grasp-os/brain-next/contract";

// The page's own lists of kinds and attributes (shared's
// brain-memories.ts, which can't reach the Brain's contract) are the
// Brain's, both ways: a kind or an attribute added to one fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AnyAttribute = {
  [K in EntityKind]: keyof (typeof entityAttributes)[K];
}[EntityKind];
const listsAgree: [
  Same<EntityKind, BrainEntityKind>,
  Same<AnyAttribute, BrainMemoryAttribute>,
] = [true, true];
void listsAgree;

const memoryStoreSchema = z.enum(["own", "shared"]);

/** `store` as `reader` reaches it. */
const storeNamed = (
  env: BrainEnv,
  reader: PersonReader,
  store: MemoryStoreName
): Brain => (store === "own" ? ownBrain(env, reader.person) : brain(env));

/** Where a listing goes on: in `store`, after `after` (from its start when absent). */
export interface StorePlace<C> {
  store: MemoryStoreName;
  after?: C;
}

/** A page of a listing across both stores, and where it goes on: null at the last. */
export interface AcrossStores<T, C> {
  items: T[];
  next: StorePlace<C> | null;
}

/** A page of one store's listing, as each of the Brain's listings pages. */
interface StorePage<T, C> {
  items: T[];
  more: boolean;
  next?: C;
}

/**
 * A page of a listing across the person's own store and the shared one,
 * from `from` (their own store's start when absent): a page of the store
 * it is in, and once their own store has no more, the shared one's first
 * page with it. Their own store's part is left out while it fails
 * (`ownOr`), never the shared one's.
 */
const acrossStores = async <T, C>(
  from: StorePlace<C> | undefined,
  read: (store: MemoryStoreName, after?: C) => Promise<StorePage<T, C>>
): Promise<AcrossStores<T, C>> => {
  const place: StorePlace<C> = from ?? { store: "own" };
  const page =
    place.store === "own"
      ? await ownOr(async () => await read("own", place.after), {
          items: [],
          more: false,
        })
      : await read("shared", place.after);
  const { items } = page;
  if (page.more && page.next !== undefined) {
    return { items, next: { store: place.store, after: page.next } };
  }
  if (place.store === "shared") {
    return { items, next: null };
  }
  const shared = await read("shared");
  return {
    items: [...items, ...shared.items],
    next:
      shared.more && shared.next !== undefined
        ? { store: "shared", after: shared.next }
        : null,
  };
};

/** An entity in one of the stores, as a listing names it. */
export interface StoredEntity {
  store: MemoryStoreName;
  id: EntityId;
  kind: EntityKind;
  name: string | null;
  /**
   * The person's own entity stands for a shared one (a correction made
   * it) that they may no longer read: shown with no name at all, as for
   * one there isn't.
   */
  unreadable: boolean;
}

/**
 * `entity` as the page names it, as `reader` may see it now. One of the
 * person's own that a correction made stands for a shared entity
 * (`sharedEntityRefOf`) and holds no name of its own: its name is that
 * shared entity's earliest name the reader may see, read live from the
 * shared store, as the page reads a shared entity, never kept; when they
 * may no longer read it, or it is gone, alike, `unreadable`. Any other
 * entity as the store gives it. Per entity: the store has no read of
 * several entities at once, so a page of own entities takes at most a
 * page of these, each two reads (its identifiers, the shared entity).
 */
const liveNamed = async (
  env: BrainEnv,
  reader: PersonReader,
  store: MemoryStoreName,
  entity: Entity
): Promise<StoredEntity> => {
  const plain = { store, ...entity, unreadable: false };
  if (store !== "own" || entity.name !== null) {
    return plain;
  }
  const { identifiers } = await entityNamesOf(
    ownBrain(env, reader.person),
    reader,
    entity.id
  );
  const standsFor = identifiers.find(isSharedEntityRef);
  if (standsFor === undefined) {
    return plain;
  }
  const shared = await brain(env).readEntity({
    entity: standsFor.value.slice(sharedEntityRefPrefix.length),
    reader,
  });
  return shared === null
    ? { ...plain, unreadable: true }
    : { ...plain, name: shared.name };
};

const entitiesWantedSchema = z.strictObject({
  kind: z.enum(entityKinds),
  from: z
    .strictObject({
      store: memoryStoreSchema,
      after: entitiesCursorSchema.optional(),
    })
    .optional(),
});

/**
 * A page of the entities of `kind` the member `personId` may see, their
 * own store's first, then the shared one's, each in the order the store
 * finds them, from `from`. Refused once they are no longer a member.
 */
export const entitiesAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted:
    | { kind: EntityKind; from?: StorePlace<EntitiesCursor> }
    | Readonly<Record<string, unknown>>
): Promise<AcrossStores<StoredEntity, EntitiesCursor>> => {
  const { kind, from } = checked(entitiesWantedSchema, wanted);
  // The person on their own Brain page: both stores (`"person"` reach).
  const reader = await personReaderOf(env, personId);
  return await acrossStores(from, async (store, after) => {
    const found = await storeNamed(env, reader, store).findEntities({
      reader,
      kind,
      ...(after === undefined ? {} : { after }),
    });
    return {
      items: await Promise.all(
        found.entities.map(
          async (each) => await liveNamed(env, reader, store, each)
        )
      ),
      more: found.more,
      next: found.next,
    };
  });
};

const entityRefSchema = z.strictObject({
  store: memoryStoreSchema,
  id: entityIdSchema,
});

/**
 * A memory as the page shows it: the store's own, with the source it was
 * drawn from as its producer named it, and the entity it relates to with
 * its earliest name the reader may see.
 */
export interface StoredMemory extends Omit<Memory, "source" | "object"> {
  store: MemoryStoreName;
  source: { source: SourceRef; version: number } | null;
  object: { id: EntityId; name: string | null } | null;
}

/** `memories` of `store`, as the page shows them to `reader` (above). */
const storedMemories = async (
  store: Brain,
  name: MemoryStoreName,
  reader: Reader,
  memories: readonly Memory[]
): Promise<StoredMemory[]> => {
  const objects = [
    ...new Set(
      memories.flatMap(({ object }) => (object === null ? [] : [object]))
    ),
  ];
  const names = new Map(
    await Promise.all(
      objects.map(async (id) => {
        const read = await store.readEntity({ entity: id, reader });
        return [id, read?.name ?? null] as const;
      })
    )
  );
  return memories.map(({ source, object, ...memory }) => ({
    ...memory,
    store: name,
    source:
      source === null
        ? null
        : { source: sourceRefOf(source.source), version: source.version },
    object:
      object === null ? null : { id: object, name: names.get(object) ?? null },
  }));
};

const memoriesWantedSchema = z.strictObject({
  entity: entityRefSchema,
  after: memoriesCursorSchema.optional(),
});

/** A page of an entity's memories, and where it goes on: null at the last. */
export interface StoredMemoryPage {
  /**
   * The entity as the reader may see it now (`liveNamed`), what the page
   * names it by: null alike when there is none and when they may no
   * longer see it.
   */
  entity: StoredEntity | null;
  memories: StoredMemory[];
  next: MemoriesCursor | null;
}

/**
 * A page of what the Brain remembers about `entity` that the member
 * `personId` may read, history included, in the store's order, after
 * `after`: none, alike, for an entity there isn't or they may not see.
 * Refused once they are no longer a member.
 */
export const memoriesAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted:
    | { entity: { store: MemoryStoreName; id: string }; after?: MemoriesCursor }
    | Readonly<Record<string, unknown>>
): Promise<StoredMemoryPage> => {
  const { entity, after } = checked(memoriesWantedSchema, wanted);
  // The person on their own Brain page: both stores (`"person"` reach).
  const reader = await personReaderOf(env, personId);
  const store = storeNamed(env, reader, entity.store);
  const [page, read] = await Promise.all([
    store.readMemories({
      entity: entity.id,
      reader,
      history: true,
      ...(after === undefined ? {} : { after }),
    }),
    store.readEntity({ entity: entity.id, reader }),
  ]);
  return {
    entity:
      read === null ? null : await liveNamed(env, reader, entity.store, read),
    memories: await storedMemories(store, entity.store, reader, page.memories),
    next: page.more && page.next !== undefined ? page.next : null,
  };
};

/** A fact sources disagree on, as the page shows it. */
export interface StoredContestedFact {
  about: StoredEntity;
  attribute: string;
  sides: StoredMemory[];
  more: boolean;
}

const contestedWantedSchema = z.strictObject({
  from: z
    .strictObject({
      store: memoryStoreSchema,
      after: contestedCursorSchema.optional(),
    })
    .optional(),
});

/**
 * A page of the facts sources disagree on that the member `personId` may
 * read, their own store's first, then the shared one's, from `from`: each
 * with the entity it is about and its first sides, as the store gives
 * them. Refused once they are no longer a member.
 */
export const contestedAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted:
    | { from?: StorePlace<ContestedCursor> }
    | Readonly<Record<string, unknown>> = {}
): Promise<AcrossStores<StoredContestedFact, ContestedCursor>> => {
  const { from } = checked(contestedWantedSchema, wanted);
  // The person on their own Brain page: both stores (`"person"` reach).
  const reader = await personReaderOf(env, personId);
  return await acrossStores(from, async (name, after) => {
    const store = storeNamed(env, reader, name);
    const page = await store.listContested({
      reader,
      ...(after === undefined ? {} : { after }),
    });
    const facts = await Promise.all(
      page.facts.map(async ({ about, attribute, memories, more }) => {
        const entity = await store.readEntity({ entity: about, reader });
        // Read after the listing: who may read a source can change in
        // between, and a fact they may no longer read is left out, as the
        // store leaves out what that change hides (contract v11).
        return entity === null
          ? []
          : [
              {
                about: await liveNamed(env, reader, name, entity),
                attribute,
                sides: await storedMemories(store, name, reader, memories),
                more,
              },
            ];
      })
    );
    return { items: facts.flat(), more: page.more, next: page.next };
  });
};

const memoryRefSchema = z.strictObject({
  store: memoryStoreSchema,
  entity: entityIdSchema,
  memory: memoryIdSchema,
});

/** A memory, by its store and id, with the entity it is about. */
export type StoredMemoryRef = z.infer<typeof memoryRefSchema>;

const memoryPlaceSchema = memoryRefSchema.omit({ entity: true });

/** A memory, by its store and id. */
export type StoredMemoryPlace = z.infer<typeof memoryPlaceSchema>;

/**
 * The member `personId` confirms memory `memory`, current and one they may
 * read, over the current memories they may read that say otherwise, as
 * their own word (the Brain's `confirmMemory`): `nothing` alike for one
 * there isn't, they may not read, or that isn't current. Refused once
 * they are no longer a member.
 */
export const confirmAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  memory: StoredMemoryPlace | Readonly<Record<string, unknown>>
): Promise<MemoryChangeOutcome> => {
  const { store, memory: id } = checked(memoryPlaceSchema, memory);
  // The person on their own Brain page: both stores (`"person"` reach).
  const reader = await personReaderOf(env, personId);
  try {
    return await storeNamed(env, reader, store).confirmMemory({
      memory: id,
      reader,
    });
  } catch (error) {
    throw erasedAs(error);
  }
};

const correctionSchema = z.strictObject({
  wrong: memoryRefSchema,
  right: memoryText(valueMaxLength),
  // Minted once by the page when the person starts the correction.
  change: z.uuid(),
});

/** A correction, as `correctAs` takes it. */
export type Correction = z.input<typeof correctionSchema>;

/**
 * The member `personId` says memory `wrong` is wrong, and what is right
 * (`right`): saved as their own word, readable by them alone, in their own
 * store (`rememberAs`), and confirmed there over what they may read that
 * says otherwise. About the same entity: in their own store by its id;
 * from the shared one, the entity of theirs that stands for it, found by
 * its exact identifier (`sharedEntityRefOf`) alone, made at the first
 * correction with no name of its own (`liveNamed` names it). Under the same
 * attribute when it holds a value, so a newer correction of a one-value
 * attribute ends the one before. A wrong memory that is their own word is
 * retired too, as `forgetAs` retires it: on a many-value attribute the
 * correction would otherwise stand beside it.
 *
 * The shared store is left as it is: a correction others may read would
 * widen what the person read, theirs to publish, not this. What is saved
 * is built from what never changes for one correction (the entity's id
 * and kind, the memory's attribute and type, the text), so the same
 * `change` again answers what it saved while the wrong memory is one they
 * may still read, whatever else has happened to it since (ended by it, or
 * retired), and confirms and retires again, each a repeat that records
 * nothing new. Once they may no longer read it (its source narrowed or
 * erased), a retry answers null, as for any memory they may not read: a
 * correction an earlier try saved stays in their own store, where the
 * page shows it and they can confirm it themselves. The same `change`
 * with other text is refused (`brain.correction_reused`). Null alike when
 * the memory isn't one they may read and when it is a relation. Refused
 * once they are no longer a member.
 */
export const correctAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  correction: Correction | Readonly<Record<string, unknown>>
): Promise<RememberedMemory | null> => {
  const { wrong, right, change } = checked(correctionSchema, correction);
  // The person on their own Brain page: both stores (`"person"` reach).
  const reader = await personReaderOf(env, personId);
  const store = storeNamed(env, reader, wrong.store);
  const [read, entity] = await Promise.all([
    keptMemory(store, reader, wrong.entity, wrong.memory),
    store.readEntity({ entity: wrong.entity, reader }),
  ]);
  // A relation names another entity, which the person's own word can't:
  // it is not one a correction takes, alike for one there isn't.
  if (read === undefined || entity === null || read.object !== null) {
    return null;
  }
  // No name of the shared entity is copied: a copy would outlive a
  // narrowing or an erasure of the source that gave it. The page names
  // it live (`liveNamed`).
  const about =
    wrong.store === "own"
      ? { id: entity.id, kind: entity.kind }
      : { kind: entity.kind, identifiers: [sharedEntityRefOf(entity.id)] };
  const attribute = read.attribute ?? undefined;
  let saved: RememberedMemory;
  try {
    saved = await rememberAs(env, personId, {
      change: `correct:${change}`,
      about,
      ...(attribute === undefined ? {} : { attribute, value: right }),
      type: read.type,
      statement: right,
      quote: right,
    });
  } catch (error) {
    if (error instanceof Error && error.message === changeReused) {
      throw brainMemoryErrors.create("brain.correction_reused");
    }
    throw error;
  }
  const own = ownBrain(env, reader.person);
  try {
    await own.confirmMemory({ memory: saved.memory, reader });
    if (wrong.store === "own" && read.writer === reader.person) {
      await own.retireMemory({ memory: read.id, reader });
    }
  } catch (error) {
    throw erasedAs(error);
  }
  return saved;
};

// Memories and entities for code (GRA-1837, threat model on the issue):
// what an App's action or a workflow's step remembers, forgets and
// corrects, in its own word, and the entities it reads. All of it in the
// shared store, read as the company alone (`company`): code never reads
// or writes a person's own store, so what it writes is read by the
// company, as everything it may read is, and it reads back what it wrote.
// Whether code may write at all (its grant, and that the company may read
// everything it may have read) is its caller's to decide first
// (brain-recall.ts): these only ever write in the company's readers.

/** Who may read what code writes: every member, as code reads. */
const companyAccess: Access = { kind: "audience", group: companyGroup };

/**
 * Who writes for code, as the Brain names a writer: the App
 * (`app:<id>`) or the workflow (`workflow:<id>`) whose code it is. Set by
 * core, never by the code.
 */
const codeWriterSchema = wellFormedString()
  .regex(/^(?:app|workflow):\S+$/u)
  .max(principalMaxLength);

/**
 * The attributes code may file a memory under: those whose value is a
 * text, but a person's preference or instruction, which is only ever
 * that person's own word.
 */
const codeAttributes = attributeNames.filter(
  (name) => name !== "preference" && name !== "instruction"
);

/** A memory code says about an entity (`rememberForCompanyAs`). */
const codeRememberedSchema = z.strictObject({
  about: memoryAboutSchema,
  attribute: z.enum(codeAttributes).optional(),
  value: memoryText(valueMaxLength).optional(),
  statement: memoryText(statementMaxLength),
});

/** A memory of its own code forgets (`forgetForCompanyAs`). */
const codeForgetSchema = z.strictObject({ memory: memoryIdSchema });

/** A correction code makes of a memory (`correctForCompanyAs`). */
const codeCorrectionSchema = z.strictObject({
  memory: memoryIdSchema,
  value: memoryText(valueMaxLength).optional(),
  statement: memoryText(statementMaxLength),
});

/**
 * `error` as core gives it: an erased store's or key's as
 * `brain.source_erased` (`erasedAs`); a refusal of the Brain's rules
 * (an id it doesn't name, a value its attribute doesn't take, a cursor it
 * didn't give) as `brain.request_invalid`, the same whatever the rule, so
 * an id the reader may not read is refused as one nobody holds. A store
 * restoring an export, or any other error, as it is: not the caller's to
 * mend.
 */
const refusedAs = (error: unknown): unknown => {
  const erased = erasedAs(error);
  if (erased !== error) {
    return erased;
  }
  return error instanceof Error &&
    error.message.startsWith(refusalPrefix) &&
    error.message !== restoringNow
    ? brainSourceErrors.create("brain.request_invalid")
    : error;
};

/**
 * Saves what code says, in `writer`'s word (`app:<id>`, `workflow:<id>`),
 * for the member `personId`, in the shared store, readable by the company:
 * a fact about an entity the company may read (by id), or one found by an
 * exact identifier there, or a new one; never a preference or an
 * instruction. The same writer's new word on the same entity and
 * one-value attribute ends its earlier memory, which stays as history.
 * `change` names this one save, minted by core: the same change again
 * answers what it saved. Refused once `personId` is no longer a member,
 * and as `brain.request_invalid` for what the Brain's rules refuse.
 */
export const rememberForCompanyAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  { writer, change }: { writer: string; change: string },
  remembered: unknown
): Promise<{ memory: MemoryId; entity: EntityId }> => {
  const { about, statement, ...memory } = checked(
    codeRememberedSchema,
    remembered
  );
  const by = checked(codeWriterSchema, writer);
  const reader = await readerOf(env, personId, "company");
  let added: Awaited<ReturnType<Brain["addMemories"]>>;
  try {
    added = await brain(env).addMemories({
      change: checked(changeSchema, change),
      access: companyAccess,
      // An entity's id is taken only as the company may see it.
      reader,
      entities: [{ key: "about", ...about }],
      memories: [
        {
          about: "about",
          ...memory,
          type: "fact",
          statement,
          speaker: { kind: "agent", agent: by },
          basis: { kind: "writer", writer: by },
        },
      ],
    });
  } catch (error) {
    throw refusedAs(error);
  }
  const [saved] = added.memories;
  const entity = added.entities.about;
  if (saved === undefined || entity === undefined) {
    throw new Error("The Brain kept no memory");
  }
  return { memory: saved, entity };
};

/**
 * Retires one of `writer`'s own memories (`{ memory }`) in the shared
 * store, as the company reads it, for the member `personId`: `done`, again for one
 * retired before; `nothing` alike for none, another writer's (a person's,
 * a source's or another App's), and an expired one. Refused once
 * `personId` is no longer a member.
 */
export const forgetForCompanyAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  writer: string,
  request: unknown
): Promise<MemoryChangeOutcome> => {
  const { memory: id } = checked(codeForgetSchema, request);
  const by = checked(codeWriterSchema, writer);
  const reader = await readerOf(env, personId, "company");
  try {
    return await brain(env).retireMemory({ memory: id, reader, writer: by });
  } catch (error) {
    throw refusedAs(error);
  }
};

/**
 * Corrects a current memory of the shared store the company may read, for
 * the member `personId`, in `writer`'s word (contract `correctMemory`):
 * the fix under exactly that memory's readers, confirmed over what says
 * otherwise. The fix's id, or null alike when there is no such memory the
 * company may read that is current, it is a relation, or its readers
 * can't be kept. `change` as `rememberForCompanyAs`'s.
 */
export const correctForCompanyAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  { writer, change }: { writer: string; change: string },
  correction: unknown
): Promise<MemoryId | null> => {
  const { memory, value, statement } = checked(
    codeCorrectionSchema,
    correction
  );
  const by = checked(codeWriterSchema, writer);
  const reader = await readerOf(env, personId, "company");
  try {
    return await brain(env).correctMemory({
      change: checked(changeSchema, change),
      memory,
      reader,
      writer: by,
      speaker: { kind: "agent", agent: by },
      ...(value === undefined ? {} : { value }),
      statement,
    });
  } catch (error) {
    throw refusedAs(error);
  }
};

/** Most characters of a page's cursor as code holds it: well past any the store gives. */
const cursorTextMax = 2000;

/**
 * Where a page ended, as code holds it: the store's cursor as JSON, in
 * base64, which code passes back untouched and the store checks again.
 */
const cursorTextOf = (cursor: object | undefined): string | null =>
  cursor === undefined ? null : btoa(JSON.stringify(cursor));

/** The moments a store's cursor holds, which JSON wrote as text. */
const cursorMoments = ["at", "learned", "learnedAt"] as const;

/**
 * A cursor `cursorTextOf` wrote, read back as `schema` (the store's own,
 * which the store checks again): refused as `brain.request_invalid` when
 * it isn't one.
 */
const cursorOfText = <T>(schema: z.ZodType<T>, text: string): T => {
  let read: unknown;
  try {
    read = JSON.parse(atob(checked(z.string().max(cursorTextMax), text)));
  } catch {
    throw brainSourceErrors.create("brain.request_invalid");
  }
  if (typeof read !== "object" || read === null || Array.isArray(read)) {
    throw brainSourceErrors.create("brain.request_invalid");
  }
  const cursor: Record<string, unknown> = { ...read };
  for (const moment of cursorMoments) {
    const value = cursor[moment];
    if (typeof value === "string") {
      cursor[moment] = new Date(value);
    }
  }
  return checked(schema, cursor);
};

/** A moment code reads as of: ISO 8601, with its offset. */
const codeMomentSchema = z.iso
  .datetime({ offset: true })
  .transform((at) => new Date(at));

/** A card code asks for (`companyCardAs`). */
const codeCardSchema = z.strictObject({
  entity: entityIdSchema,
  asOf: codeMomentSchema.optional(),
  after: z.string().optional(),
});

/** A memory on a card, its source as core names it. */
export interface CardMemory extends Omit<Memory, "source"> {
  source: SourceVersionRef | null;
}

/** A page of an entity's card as code reads it: the store's, memories cited as core names sources. */
export interface CompanyCard {
  entity: { id: EntityId; kind: EntityKind; name: string | null };
  attributes: {
    attribute: string;
    memories: CardMemory[];
    contested: boolean;
  }[];
  relations: {
    attribute: string | null;
    side: "about" | "object";
    other: { id: EntityId; kind: EntityKind; name: string | null };
    memory: CardMemory;
  }[];
  notes: CardMemory[];
  next: string | null;
}

/** `memory` with its source as core names it. */
const cardMemoryOf = ({ source, ...memory }: Memory): CardMemory => ({
  ...memory,
  source: versionRefOf(source),
});

/**
 * A page of entity `entity`'s card as the company may read it, for the
 * member `personId` (code's reach: never a team's or a person's own), as
 * now or as of `asOf`, after `after` (a page's `next`): null alike when the
 * company may see no such entity and when nobody holds one. Refused once
 * `personId` is no longer a member, and as `brain.request_invalid` for a
 * request or cursor that isn't one.
 */
export const companyCardAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  request: unknown
): Promise<CompanyCard | null> => {
  const { entity, asOf, after } = checked(codeCardSchema, request);
  const reader = await readerOf(env, personId, "company");
  let card: Awaited<ReturnType<Brain["readCard"]>>;
  try {
    card = await brain(env).readCard({
      entity,
      reader,
      ...(asOf === undefined ? {} : { asOf }),
      ...(after === undefined
        ? {}
        : { after: cursorOfText(memoriesCursorSchema, after) }),
    });
  } catch (error) {
    throw refusedAs(error);
  }
  if (card === null) {
    return null;
  }
  return {
    entity: card.entity,
    attributes: card.attributes.map(({ memories, ...attribute }) => ({
      ...attribute,
      memories: memories.map((memory) => cardMemoryOf(memory)),
    })),
    relations: card.relations.map(({ memory, ...relation }) => ({
      ...relation,
      memory: cardMemoryOf(memory),
    })),
    notes: card.notes.map((memory) => cardMemoryOf(memory)),
    next: cursorTextOf(card.next),
  };
};

/** Entities code asks to find (`companyEntitiesAs`): a kind, a name or an identifier, at least one. */
const codeFindSchema = z
  .strictObject({
    kind: z.enum(entityKinds).optional(),
    name: memoryText(valueMaxLength).optional(),
    identifier: identifierSchema.optional(),
    after: z.string().optional(),
  })
  .refine(
    ({ kind, name, identifier }) =>
      kind !== undefined || name !== undefined || identifier !== undefined
  );

/** A page of entities as code reads it. */
interface CompanyEntities {
  entities: { id: EntityId; kind: EntityKind; name: string | null }[];
  next: string | null;
}

/**
 * A page of the entities the company may see that match `request`'s kind,
 * name (whole, folded) or exact identifier, for the member `personId`,
 * after `after` (a page's `next`), in the order of the first memory the
 * company may read that mentions each. Refused once `personId` is no
 * longer a member, and as `brain.request_invalid` for a request or cursor
 * that isn't one.
 */
export const companyEntitiesAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  request: unknown
): Promise<CompanyEntities> => {
  const { after, ...asked } = checked(codeFindSchema, request);
  const reader = await readerOf(env, personId, "company");
  let page: Awaited<ReturnType<Brain["findEntities"]>>;
  try {
    page = await brain(env).findEntities({
      reader,
      ...asked,
      ...(after === undefined
        ? {}
        : { after: cursorOfText(entitiesCursorSchema, after) }),
    });
  } catch (error) {
    throw refusedAs(error);
  }
  return { entities: page.entities, next: cursorTextOf(page.next) };
};

/** What code asks of the Brain's memories and entities, beside recall, by operation. */
const codeMemoryRequests = {
  remember: codeRememberedSchema,
  forget: codeForgetSchema,
  correct: codeCorrectionSchema,
  "entities.get": codeCardSchema,
  "entities.find": codeFindSchema,
} as const;

/** What code asks of the Brain's memories and entities: `ctx.brain.<operation>`. */
export type CodeMemoryOperation = keyof typeof codeMemoryRequests;

/**
 * Whether `input` is a request code may make of `operation`, as the
 * functions above take it: for core to refuse it before anything else
 * is looked at, as a recall's (`codeRecallOf`).
 */
export const isCodeMemoryRequest = (
  operation: CodeMemoryOperation,
  input: unknown
): boolean =>
  Object.hasOwn(codeMemoryRequests, operation) &&
  codeMemoryRequests[operation].safeParse(input).success;

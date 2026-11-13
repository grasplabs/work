import { packAcross, sourcesAcross } from "@grasp-os/brain-next/across";
import {
  brainOf,
  currentReadMax,
  fitsSourceText,
  erasedSource,
  listPageMax,
  erasureReasons,
  handOversMax,
  instructionsMaxLength,
  instructionsTextSchema,
  isOverInstructionsLimit,
  isStillDeleting,
  principalMaxLength,
  questionMaxLength,
  readableCheckMax,
  sourceIdMaxLength,
  storeErased,
  wellFormedString,
  modelWaitMaxSeconds,
  packItemTokens,
  personalBrainOf,
  storeBytesMax,
  storeKindOf,
} from "@grasp-os/brain-next/contract";
import type {
  Access,
  AskModel,
  Brain,
  ErasureReason,
  Embedders,
  KeyState,
  HandOverPriority,
  HandOverResult,
  HandOvers,
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
import { skillCardOf, skillNameSchema } from "@grasp-os/brain-next/skills";
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
import { modelForRole, modelSettings, models } from "./models.ts";
import { shippedSkills } from "./shipped-skills.ts";
import { skillCards, skillCardsKept } from "./skill-cards.ts";
import type { SkillCardText } from "./skill-cards.ts";

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
// `chat` stays although nothing produces it now: stores filled between
// #2157 and its revert hold chat sources, and a recall that meets one must
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
 * What only one person may read (`owner`) is kept in their own store,
 * anything else in the shared one; a source keeps its kind of readers,
 * and its person, for its whole life (`keptIn`): `owner` readers for a
 * source the shared store holds are refused.
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
  const access = accessOf(readers);
  const key = sourceKeyOf(source);
  let version: number;
  try {
    ({ version } = await keptIn(
      env,
      key,
      access,
      async (store) =>
        await store.addSource({ source: key, change, text, access })
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
 * With `personal`, from the shared store and their own together, packed
 * as one store holding both would pack them (`packAcross`); without, from
 * the shared store alone. Refused once they are no longer a member, or
 * when `personId` isn't an ID.
 */
export const recallAs = async (
  env: BrainEnv & Pick<Env, "DB" | "EMBEDDER">,
  personId: string,
  { question: asked, budget, asOf, personal }: Recall
): Promise<RecalledPack> => {
  // As the Brain checks it, before the embedder sees any of it.
  const question = checked(questionSchema, asked);
  const [reader, meaning] = await Promise.all([
    readerOf(env, personId),
    // As of a moment the Brain never searches by meaning: nothing to embed.
    asOf === undefined ? meaningOf(env, question) : {},
  ]);
  const request: RecallRequest = {
    question,
    reader,
    budget,
    ...(asOf === undefined ? {} : { asOf }),
    ...meaning,
  };
  const { items, notFound, truncated } = personal
    ? packAcross(
        question,
        budget.tokens,
        // The same request of both, the shared store first, as ties go
        // to the store given first.
        await Promise.all([
          brain(env).find(request),
          ownBrain(env, reader.person).find(request),
        ])
      )
    : await brain(env).recall(request);
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

/** Where an item of a pack is: its source, version and place. */
const placeOf = ({ source, version, position }: RecalledItem): string =>
  JSON.stringify([sourceKeyOf(source), version, position]);

/**
 * Two recalls for one reader as one pack within `budget.tokens`: the
 * first's items in their order, then the second's that the first doesn't
 * hold (the same passage of the same version), best first, each while it
 * fits as the Brain counts it (`packItemTokens`); cut short when either
 * was or one of the second's didn't fit. What was not found is the
 * second's: it was asked for what the first meant. Both must be packs of
 * the same reader's, as `recallAs` gave them.
 */
export const mergeRecalled = (
  first: RecalledPack,
  second: RecalledPack,
  budget: { tokens: number }
): RecalledPack => {
  const tokensOf = (item: RecalledItem): number =>
    packItemTokens({ ...item, source: sourceKeyOf(item.source) });
  const held = new Set(first.items.map((item) => placeOf(item)));
  const items = [...first.items];
  let used = items.reduce((sum, item) => sum + tokensOf(item), 0);
  let truncated = first.truncated || second.truncated;
  for (const item of second.items) {
    const place = placeOf(item);
    if (held.has(place)) {
      continue;
    }
    const tokens = tokensOf(item);
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
  const reader = await readerOf(env, personId);
  const request = { source: sourceKeyOf(source), version, reader };
  const read =
    (await brain(env).readVersion(request)) ??
    (await ownBrain(env, reader.person).readVersion(request));
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
  const reader = await readerOf(env, personId);
  const request = {
    reader,
    prefixes: producerKinds.map((kind) => `${kind}:`),
    ...(from === undefined
      ? {}
      : { after: { addedAt: from.addedAt, source: sourceKeyOf(from.source) } }),
  };
  const { sources, more } = sourcesAcross(
    await Promise.all([
      brain(env).listSources(request),
      ownOr(
        async () => await ownBrain(env, reader.person).listSources(request),
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
  const reader = await readerOf(env, personId);
  const request = {
    source: sourceKeyOf(source),
    reader,
    ...(before === undefined ? {} : { before }),
  };
  const shared = await brain(env).listVersions(request);
  const { versions, more } =
    shared.versions.length > 0
      ? shared
      : await ownBrain(env, reader.person).listVersions(request);
  const last = versions.at(-1);
  return {
    versions: versions.map(({ version, addedAt }) => ({ version, addedAt })),
    before: more && last !== undefined ? last.version : null,
  };
};

const versionRefsSchema = z.array(versionRefSchema);

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

/**
 * Of `versions`, those the member `personId` may read now, as
 * `readSourceVersionAs` decides it, in the order given and each once,
 * without reading their text: for core to check what a chat once read
 * before it sends it again (history-access.ts). Of the shared store, and
 * of their own for those the shared one doesn't answer: a source is in
 * one of them (`keptIn`). Their own store failing answers none of its own
 * (`ownOr`): what can't be checked is withheld. Refused once they are no
 * longer a member. For the server only, as `addSource`.
 */
export const readableVersionsAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  versions: readonly SourceVersionRef[]
): Promise<SourceVersionRef[]> => {
  const asked = checked(versionRefsSchema, versions);
  if (asked.length === 0) {
    return [];
  }
  const reader = await readerOf(env, personId);
  const keys = [
    ...new Map(
      asked.map(({ source, version }) => {
        const key = { source: sourceKeyOf(source), version };
        return [versionKeyOf(key), key] as const;
      })
    ).values(),
  ];
  const inShared = await readableIn(brain(env), reader, keys);
  const shared = new Set(inShared.map((key) => versionKeyOf(key)));
  const rest = keys.filter((key) => !shared.has(versionKeyOf(key)));
  const own =
    rest.length === 0
      ? []
      : await ownOr(
          async () =>
            await readableIn(ownBrain(env, reader.person), reader, rest),
          []
        );
  const kept = new Set([...shared, ...own.map((key) => versionKeyOf(key))]);
  const seen = new Set<string>();
  return asked.filter(({ source, version }) => {
    const key = versionKeyOf({ source: sourceKeyOf(source), version });
    if (!kept.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
});

const personErasureSchema = z.strictObject({
  personId: idSchema,
  reason: z.enum(erasureReasons),
});

/**
 * Erases `source` for good: every version, with everything kept of it.
 * Its key is closed: a later add of it is refused, so a producer's late
 * retry never brings it back. Safe to repeat. For a producer's deletion
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
  erased: { source: SourceRef; readers: SourceReaders; reason: ErasureReason }
): Promise<void> => {
  const { source, readers, reason } = checked(sourceErasureSchema, erased);
  const request = { source: sourceKeyOf(source), reason };
  // In its person's own store first, when it is theirs, and only once
  // that returned closed in the shared store, whatever its readers: the
  // shared ledger, which staff read, never says erased while a copy is
  // left. A failure of the first leaves the shared store as it was, and
  // the retry does both, in order.
  if (readers.kind === "owner") {
    await ownBrain(env, readers.personId).eraseSource(request);
  }
  await brain(env).eraseSource(request);
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
  const access = instructionAccessOf(file);
  const key = instructionKeyOf(file);
  const { version } = await keptIn(
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

// Skills (GRA-1826): how things are done, as `SKILL.md` documents, kept
// whole like instruction files (never indexed, so recall never returns
// one), each a source under `skillsKind`: Grasp's own, which each release
// ships (`scope` "grasp"), and the company's shared ones ("company").
// Every current member may read both, as the company's instruction file:
// a skill is guidance and grants no access. Which skills a chat or run
// gets, and the release's install, are brain-skills.ts's rule; the
// functions here only name them for the Brain. Nobody but the release's
// install (and, later, an approved publish) adds one: no producer can
// name a skill's key (`kindsWithoutColon`).

/** Where a skill comes from: Grasp's release, or the company's own. */
const skillScopes = ["grasp", "company"] as const;

/** Where a skill comes from. */
export type SkillScope = (typeof skillScopes)[number];

const skillSchema = z.strictObject({
  scope: z.enum(skillScopes),
  name: skillNameSchema,
});

/** A skill, by where it comes from and its name. */
export type Skill = z.infer<typeof skillSchema>;

const skillAtSchema = skillSchema.extend({ version: z.int().positive() });

/** A skill at one version: what a selection pins, and a read takes. */
export type SkillAt = z.infer<typeof skillAtSchema>;

/** A skill at its current version, and when to use it. */
export interface SkillCardAt extends SkillAt {
  description: string;
}

/** A skill at one version, whole. */
export interface SkillVersion extends SkillAt {
  text: string;
}

/** The Brain's key for `skill`: its scope is part of it. */
const skillKeyOf = ({ scope, name }: Skill): SourceId =>
  `${skillsKind}:${scope}:${name}`;

/** `key` as the skill it names, or null for one that isn't a skill's. */
const skillOfKey = (key: SourceId): Skill | null => {
  const [kind, scope, name, ...rest] = key.split(":");
  const parsed = skillSchema.safeParse({ scope, name });
  return kind === skillsKind && rest.length === 0 && parsed.success
    ? parsed.data
    : null;
};

/** Who may read a skill in the Brain: every current member. */
const skillAccess: Access = { kind: "audience", group: companyGroup };

/**
 * The release's own reader of skills, to compare what is stored with what
 * it ships: the company's group, which every skill is readable by, and a
 * person no member is (core's person principals are user IDs, which never
 * hold ":"), so it reads nothing but what the company may.
 */
const releaseReader: Reader = {
  person: "grasp:release",
  groups: [companyGroup],
};

/** The names of Grasp's skills this release ships: the only ones it adds. */
const shippedNames: ReadonlySet<string> = new Set(
  shippedSkills.map(({ name }) => name)
);

/**
 * Adds `text` as the next version of the Grasp skill `name`, one this
 * release ships, readable by every member, unless it is the skill's
 * current text already (`changed` false, and nothing written); the one
 * before stays as history. `change` is as `addSource`'s. Refused
 * (`skills.invalid`) for a name the release doesn't ship, and when the
 * text isn't a skill named `name` in the Agent Skills format or is over
 * `instructionsMaxLength` UTF-16 units, an instruction file's limit: both
 * fail the same way every time, until another release. Two adds at once
 * may both say `changed`; the store still keeps one version per text in
 * a row.
 *
 * Grasp's own skills only: the release's install (brain-skills.ts) is its
 * one caller. Nothing here adds a company skill: that write needs its own
 * authorization and audit (the approved publish, GRA-1754).
 */
export const addShippedSkill = async (
  env: BrainEnv,
  added: { name: string; change: string; text: string }
): Promise<SkillAt & { changed: boolean }> => {
  const { name, change, text } = skillErrors.parse(
    "skills.invalid",
    z.strictObject({
      name: skillNameSchema,
      change: changeSchema,
      text: instructionsTextSchema,
    }),
    added
  );
  if (!shippedNames.has(name) || skillCardOf(text)?.name !== name) {
    throw skillErrors.create("skills.invalid");
  }
  const skill: Skill = { scope: "grasp", name };
  const source = skillKeyOf(skill);
  const [current] = await brain(env).readCurrent({
    sources: [source],
    reader: releaseReader,
  });
  if (current?.text === text) {
    return { ...skill, version: current.version, changed: false };
  }
  const { version } = await brain(env).addInstructions({
    source,
    change,
    text,
    access: skillAccess,
  });
  return { ...skill, version, changed: true };
};

/**
 * Most of the company's skills a listing answers: past them, the ones
 * whose current version is oldest are left out. Far more than a company
 * writes.
 */
const companySkillsMax = 10 * listPageMax;

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

/** The card `text` declares, if it is the one `source` names. */
const declaredCard = (source: SourceId, text: string): SkillCardText | null => {
  const card = skillCardOf(text);
  return card !== null && card.name === skillOfKey(source)?.name
    ? { description: card.description }
    : null;
};

/**
 * `personId` as a reader of skills: the person, and the company, which
 * every current member is in. Refused once they have no current
 * membership.
 */
const skillReaderOf = async (
  env: Pick<Env, "DB">,
  personId: string
): Promise<Reader> => {
  const member = await memberOf(env.DB, checked(idSchema, personId));
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return { person: member.userId, groups: [companyGroup] };
};

/** The current versions of `sources`, whole, a batch at a time, in order. */
const readEachCurrent = async (
  env: BrainEnv,
  reader: Reader,
  sources: readonly SourceId[]
) => {
  const read: Awaited<ReturnType<Brain["readCurrent"]>> = [];
  for (let at = 0; at < sources.length; at += currentReadMax) {
    // oxlint-disable-next-line no-await-in-loop -- a few batches, in order
    const batch = await brain(env).readCurrent({
      sources: sources.slice(at, at + currentReadMax),
      reader,
    });
    read.push(...batch);
  }
  return read;
};

/**
 * The company's skills `reader` may read, newest first, at most
 * `companySkillsMax`, with their cards: those read before, the rest read
 * now. A version replaced between the listing and the read is left out,
 * as if listed a moment later.
 */
const companySkillsAs = async (
  env: BrainEnv,
  reader: Reader
): Promise<SkillCardAt[]> => {
  const listed: { source: SourceId; version: number }[] = [];
  let after: { addedAt: Date; source: SourceId } | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, in order
    const page = await brain(env).listSources({
      reader,
      prefixes: [`${skillsKind}:company:`],
      after,
      limit: listPageMax,
    });
    listed.push(...page.sources);
    const last = page.sources.at(-1);
    after =
      page.more && last !== undefined
        ? { addedAt: last.addedAt, source: last.source }
        : undefined;
  } while (after !== undefined && listed.length < companySkillsMax);
  const kept = listed.slice(0, companySkillsMax);
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
    env,
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
  return kept.flatMap(({ source, version }) => {
    const card = known.get(cardKeyOf(source, version));
    const skill = skillOfKey(source);
    return skill === null || card === undefined || card === null
      ? []
      : [{ ...skill, version, description: card.description }];
  });
};

/**
 * The skills `personId` may use, at their current versions, with their
 * descriptions: Grasp's by the names in `shipped` (this release's), read
 * by name, so however long ago they were installed; and the company's,
 * listed on their own, newest first, at most `companySkillsMax`. A
 * company skill takes the place of Grasp's of the same name. Those that
 * declare their own name only. Refused with
 * `permission.person_inactive` once they are no longer a member.
 */
export const listSkillsAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  shipped: ReadonlySet<string>
): Promise<SkillCardAt[]> => {
  const reader = await skillReaderOf(env, personId);
  const company = await companySkillsAs(env, reader);
  const replaced = new Set(company.map(({ name }) => name));
  const graspSources = [...shipped]
    .filter((name) => !replaced.has(name))
    .flatMap((name) => {
      const skill = skillSchema.safeParse({ scope: "grasp", name });
      return skill.success ? [skillKeyOf(skill.data)] : [];
    });
  const graspRead = await readEachCurrent(env, reader, graspSources);
  const grasp = graspRead.flatMap(({ source, version, text }) => {
    // Read now, so its card is held here before the cache is touched.
    const card =
      cards.get(cardKeyOf(source, version)) ?? declaredCard(source, text);
    keepCard(source, version, card);
    const skill = skillOfKey(source);
    return skill === null || card === null
      ? []
      : [{ ...skill, version, description: card.description }];
  });
  return [...grasp, ...company];
};

/**
 * `skill` at its version, whole, for `personId`, current or history while
 * they may read its current version (as `readSourceVersionAs`): `null`
 * when there is none, alike. Refused with `skills.invalid` for something
 * that isn't a skill at a version, and `permission.person_inactive` once
 * they are no longer a member.
 */
export const readSkillAs = async (
  env: BrainEnv & Pick<Env, "DB">,
  personId: string,
  wanted: SkillAt
): Promise<SkillVersion | null> => {
  const { scope, name, version } = skillErrors.parse(
    "skills.invalid",
    skillAtSchema,
    wanted
  );
  const read = await brain(env).readVersion({
    source: skillKeyOf({ scope, name }),
    version,
    reader: await skillReaderOf(env, personId),
  });
  return read === null ? null : { scope, name, version, text: read.text };
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

// Hand-overs: what core produces reaches the Brain through its work
// queue (the contract's `handOver`). Core notes what to hand over from the
// audit events of its changes (brain-hand-overs.ts), and the clock relays
// it to the queue by key alone (brain-sources.ts `relayHandOvers`, through
// `queueHandOvers`); the queue's item asks core's producers for the source
// as their records hold it when it runs (brain-sources.ts `producersOf`,
// given to `workBrain`), and tells them how it ended. The readers are
// checked here as an add's (`sourceReadersSchema`): a producer that names
// none is refused, and nothing is added.

/**
 * A source as its producer holds it now: its change, text and readers,
 * and the text to keep instead when `text` is past a source's bound
 * (`whenTooLarge`: what it is, saying plainly that the rest was too large
 * to keep, never a cut part of it); or nothing to hand over (`gone`); or
 * nothing, as the erasure of its one reader (`readers`, the store that
 * may hold it) has begun, when the Brain closes its key, as an add of it
 * may have landed after that erasure.
 */
export type Handed =
  | { kind: "gone" }
  | { kind: "erased"; readers: SourceReaders }
  | {
      kind: "source";
      change: string;
      text: string;
      whenTooLarge: string;
      readers: SourceReaders;
    };

/** How a hand-over that did something ended: added, or refused for good. */
export type HandOverEnd = Exclude<HandOverResult, { kind: "nothing" }>;

/** Core's producers, as the Brain's hand-overs reach them (brain-sources.ts). */
export interface Producers {
  /** `source` as its producer's records hold it now. */
  read: (source: SourceRef) => Promise<Handed>;
  /**
   * Records how the hand-over of `source` ended: once it did, and again
   * on a repeat. Throws when it can't, so the item is tried again.
   */
  settled: (source: SourceRef, outcome: HandOverEnd) => Promise<void>;
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
 * Refuses the hand-over of `source` for `reason`: recorded first, then,
 * when its one reader's erasure began (`closing`), its key closed. In
 * that order, as closing the key takes this item off the queue with every
 * other of its key: a refusal recorded after could, failing, never be
 * tried again. A close that fails fails the item, which is tried again,
 * recording again: each attempt records its own.
 */
const refuse = async (
  env: Env,
  producers: Producers,
  source: SourceRef,
  reason: HandOverEnd & { kind: "refused" },
  closing?: SourceReaders
): Promise<HandOverResult> => {
  await producers.settled(source, reason);
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
 * - nothing, when the producer has nothing to hand over;
 * - refused as `invalid`, when the producer's answer can't be added (no
 *   readers, a text that isn't one): never tried again;
 * - its text, or its `whenTooLarge` when the text is past a source's
 *   bound as given or as indexed (`fitsSourceText`); refused as
 *   `too_large` when neither fits;
 * - refused as `erased` when what it adds was erased: final.
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
  const handed = await producers.read(source);
  if (handed.kind === "gone") {
    return { kind: "nothing" };
  }
  const refused = async (
    reason: (HandOverEnd & { kind: "refused" })["reason"],
    closing?: SourceReaders
  ) =>
    await refuse(env, producers, source, { kind: "refused", reason }, closing);
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
  let version: number;
  try {
    ({ version } = await addSource(env, {
      source,
      change: handed.change,
      text,
      readers: readers.data,
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
  await producers.settled(source, added);
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
 * can echo what a person typed. Sent `handOversMax` at a time, one call
 * after the other: a call that fails leaves those after it unsent.
 */
export const queueHandOvers = async (
  env: BrainEnv,
  sources: readonly SourceRef[]
): Promise<void> => {
  const items = sources.flatMap((each) => {
    const source = sourceRefSchema.safeParse(each);
    return source.success
      ? [{ source: sourceKeyOf(source.data), priority: handOverPriority }]
      : [];
  });
  if (items.length < sources.length) {
    log.warn("brain.hand_over.unkeyed", {
      count: sources.length - items.length,
    });
  }
  for (let at = 0; at < items.length; at += handOversMax) {
    // oxlint-disable-next-line no-await-in-loop -- one call after the other
    await brain(env).handOver({ items: items.slice(at, at + handOversMax) });
  }
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
  report: (overview: WorkOverview) => Promise<void>;
}> => {
  const kind = storeKindOf(name);
  if (kind.kind !== "person") {
    throw new Error("Only a person's own store works on its own alarm");
  }
  return {
    ask: askModel(env),
    embedders: await embeddersOf(env),
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
 * Erasures are counts alone: never which, when, or by what hash.
 */
export const brainStaffReport = async (
  env: BrainEnv & Pick<Env, "DB">
): Promise<BrainReport & Required<Pick<BrainReport, "ownStores">>> => {
  const [overview, own] = await Promise.all([
    brain(env).workOverview(),
    ownStoresTotals(env),
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

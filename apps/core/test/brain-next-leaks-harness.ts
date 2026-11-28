import { recallBudgetMax, recallLimit } from "@grasp-os/brain-next/contract";
import type { WorkOverview } from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import {
  addSource,
  brainWorkOverview,
  recallAs,
  recallOwnedAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { brainSurfaces, textOf } from "./brain-next-surfaces.ts";
import type { Answer, Probe, Probing } from "./brain-next-surfaces.ts";
import { noProducers } from "./no-producers.ts";
import { stopIfEnded } from "./test-attempts.ts";

/**
 * What the marker test's files share (brain-next-leaks.test.ts and the
 * files beside it): the surfaces, how a pass finds what an answer, a log
 * line or a prompt gives away (`findingsOf`), and the ways a test adds,
 * reads and moves people between teams. Stateless: a test file's own
 * state (its IdP, a grant made once) stays in the file.
 */

/**
 * A word nothing else holds: 48 random bits. Short, as a pass asks every
 * marker it may not read at once, in a question and in a name of the
 * memory probes' fixture (brain-next-surfaces.ts), each with its limit.
 */
export const markerWord = (): string =>
  `m${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** Something a pass found that it may not. */
export interface Finding {
  /** Who was reading. */
  pass: string;
  /** Where: a surface's answers, the logs, or the model prompts. */
  in: string;
  /** What: the marker found (by the source it was planted in), or why. */
  found: string;
}

/** The markers of `forbidden` that `found` holds, by name. */
export const markersIn = (
  found: unknown,
  forbidden: Readonly<Record<string, string>>
): string[] => {
  const text = textOf(found).toLowerCase();
  return Object.entries(forbidden)
    .filter(([, marker]) => text.includes(marker))
    .map(([name]) => name);
};

/** Whether `name` is a method of the console. */
export const isConsoleMethod = (name: string): name is keyof Console =>
  /^[a-z]/u.test(name) && typeof Reflect.get(console, name) === "function";

/** Every console line written while `run` runs, and what it returned. */
export const logsOf = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; lines: unknown[] }> => {
  const lines: unknown[] = [];
  // Every method the console has, so a way of writing added later is read
  // too.
  const spies = Object.getOwnPropertyNames(console)
    .filter(isConsoleMethod)
    .map((name) =>
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      })
    );
  try {
    return { value: await run(), lines };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
};

/** Every member of every surface, by name, with its probe. */
export const surfaces: [string, Probe][] = brainSurfaces.flatMap(
  ({ name, probes }) =>
    Object.entries(probes).map(([member, probe]): [string, Probe] => [
      `${name} ${member}`,
      probe,
    ])
);

/**
 * Core's recall with whether the reader's own store changed what it
 * handed over (`recallOwnedAs`): the surface a test holds to its answers
 * before anything hidden was added (`answersOf`, `findingsOf`'s
 * `before`), `fromOwn` among them, which the comparison with the twins
 * leaves out (`apartFromMeaning`).
 */
export const ownedRecall = surfaces.filter(
  ([name]) => name === "core recallOwnedAs"
);

/**
 * The surfaces whose answers depend on a question's meaning
 * (`Answer.byMeaning`), each held to its answers before anything hidden
 * was added in the test that answers "by meaning exactly as before…".
 * Adding a recall surface whose answer depends on the question's meaning:
 * mark those answers `byMeaning` in its probe, name the surface here
 * (that test's shapes ask it, and its pinned lists of what each shape
 * answered fail until they name it too); a surface that answers by
 * meaning but isn't named here is a finding in every pass (`findingsOf`),
 * never held to markers alone.
 */
export const meaningSurfaces = new Set([
  "core recallAs",
  "core recallOwnedAs",
  "core recallPassagesAs",
  "core mergeRecalled",
  "core recalledTokens",
  "sources search",
  "recall recallFor",
  "recall whoKnowsFor",
]);

/** Whether `value` is an object with keys. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `value` without what recall found by meaning: every list of `items`
 * without those found by meaning, the rest of them in an order of their
 * own (a passage found by words is ranked by its meaning too, so the
 * order among them follows the question's meaning), and no `fromOwn`
 * (core's `recallOwnedAs`): the reader's own passages come in by meaning
 * only as far as they rank among the nearest of every store they may
 * read, so whether their own store changed the pack follows the
 * question's meaning too. Everything else as it is: what their own store
 * gave by words, an exact part or an entity shows in the rest.
 */
const apartFromMeaning = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(apartFromMeaning);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "fromOwn")
      .map(([key, part]) =>
        key === "items" && Array.isArray(part)
          ? [
              key,
              part
                .filter((item) => !(isRecord(item) && item.found === "meaning"))
                .map(textOf)
                .toSorted(),
            ]
          : [key, apartFromMeaning(part)]
      )
  );
};

/** Whether `got` is a pack its budget cut short. */
const cutShort = (got: Answer["got"]): boolean =>
  "value" in got && isRecord(got.value) && got.value.truncated === true;

/**
 * What a surface's answers give away: a forbidden marker, a hidden-only
 * answer unlike its answer to words nothing holds, an answer by meaning
 * unlike the same call's `before` the hidden sources were added, or no
 * answer worth the name (a probe that calls nothing, or only ever gets
 * errors, covers nothing). An answer by meaning (`Answer.byMeaning`) is
 * held to `before`, where a pass has one: a question of the markers and
 * one of their twins mean different things, so their packs differ by
 * meaning whatever is hidden. A pass without one (the planted world's
 * readers, and the restore, erasure, upload, run and export tests: they
 * add hidden sources before or beside what each reader may read, so no
 * moment holds a reader's own content without them) holds such an answer
 * to its markers and, apart from what meaning found (`apartFromMeaning`),
 * to its twins' answer: what was found by words, an exact part or an
 * entity, the memories, what was not found and whether the budget cut it
 * short must be the twins'. Two packs both cut short are held to their
 * markers alone: which passages a short budget keeps follows their order,
 * and that follows the question's meaning. The test that answers "by
 * meaning exactly as before anything the reader may not read was added"
 * holds them to non-interference, for each shape of reader core builds
 * (`readerOf`): a person in a team with their own note, a team-mate to
 * whom that note is hidden, a person in no team (an admin with nothing of
 * their own), the company alone (an App's or a workflow's code, and a turn
 * others read), the company with a team an App's grant names, and teams
 * with no person (a chat's code).
 */
export const findingsIn = (
  answers: readonly Answer[],
  forbidden: Readonly<Record<string, string>>,
  before?: readonly Answer[]
): string[] => {
  // Each hidden answer against the nothing answer of its comparison.
  const nothingOf = (like: string | undefined) =>
    answers.find((one) => one.about === "nothing" && one.like === like);
  const unlike = answers.flatMap(({ about, got, call, like, byMeaning }) => {
    const nothing = nothingOf(like);
    return about === "hidden" &&
      byMeaning === undefined &&
      textOf(got) !== textOf(nothing?.got)
      ? [
          `"${call}" answered ${textOf(got)}, unlike "${nothing?.call}": ${textOf(nothing?.got)}`,
        ]
      : [];
  });
  const unlikeApart =
    before === undefined
      ? answers.flatMap(({ about, got, call, like, byMeaning }) => {
          const nothing = nothingOf(like);
          if (
            about !== "hidden" ||
            byMeaning === undefined ||
            nothing === undefined ||
            (cutShort(got) && cutShort(nothing.got))
          ) {
            return [];
          }
          const [ours, theirs] = [
            textOf(apartFromMeaning(got)),
            textOf(apartFromMeaning(nothing.got)),
          ];
          return ours === theirs
            ? []
            : [
                `"${call}" answered ${ours} apart from what meaning found, unlike "${nothing.call}": ${theirs}`,
              ];
        })
      : [];
  const moved =
    before === undefined
      ? []
      : answers.flatMap(({ got, call, byMeaning }) => {
          const was = before.find((one) => one.call === call)?.got;
          return byMeaning && textOf(got) !== textOf(was)
            ? [
                `"${call}" answered ${textOf(got)}, unlike before anything hidden was added: ${textOf(was)}`,
              ]
            : [];
        });
  const thin = answers.some(({ got }) => "value" in got)
    ? []
    : ["no call answered"];
  return [
    ...markersIn(answers, forbidden),
    ...unlike,
    ...unlikeApart,
    ...moved,
    ...thin,
  ];
};

/**
 * The surfaces that read what the Brain holds, as a member: those probed
 * as a team-mate and an admin besides the full passes.
 */
export const readingSurfaces = new Set([
  "core recallAs",
  "core recallOwnedAs",
  "core readSourceVersionAs",
  "core readInstructionFilesAs",
  "core brainStaffReport",
  "core listSourcesAs",
  "core listVersionsAs",
  "core versionChangeAs",
  "sources list",
  "sources versions",
  "sources read",
  "sources learned",
  "sources search",
  "core entitiesAs",
  "core memoriesAs",
  "core contestedAs",
  "core ownEntityAs",
  "core ownEntityIdAs",
  "core profileAs",
  "memoriesRpc entities",
  "memoriesRpc memories",
  "memoriesRpc contested",
  "store listSources",
  "store listVersions",
  "store recall",
  "store find",
  "store readVersion",
  "store readCurrent",
  "store searchVectors",
  "store readMemories",
  "store readableMemories",
  "store findEntities",
  "store readEntityNames",
  "store readEntity",
  "store ownEntity",
  "store readProfile",
  "store readCard",
  "store findPassages",
  "store listContested",
  "store readVersionChange",
  "store readableVersions",
  "store changeVersion",
  "core recallPassagesAs",
  "recall whoKnowsFor",
  "core readableVersionsAs",
  "core readableMemoriesAs",
]);

/** The reading surfaces' probes: every reader's pass goes through them. */
export const reading = surfaces.filter(([name]) => readingSurfaces.has(name));

/** The surfaces that recall, where no instruction file may ever show. */
export const recallSurfaces = new Set([
  "core recallAs",
  "core recallOwnedAs",
  "core recallPassagesAs",
  "store recall",
  "store findPassages",
  "recall recallFor",
  "recall whoKnowsFor",
]);

/** Most times a pass that compares answers by meaning asks one surface. */
const meaningAsksMost = 5;

/**
 * What `run` answered, and every console line written meanwhile, for a
 * test that holds answers by meaning (`findingsOf`, `answersOf`). Run again while a recall it made went without meaning:
 * core then logs `brain.recall.without_meaning` (its question embedder
 * missed its deadline, as it can on a busy machine), and that answer is
 * by words alone, so unlike the same question's by meaning with nothing
 * hidden in play. At most `meaningAsksMost` times, then a failure naming
 * `name`.
 */
export const recalledByMeaning = async <T>(
  name: string,
  run: () => Promise<T>
): Promise<{ value: T; lines: unknown[] }> => {
  const lines: unknown[] = [];
  for (let ask = 0; ask < meaningAsksMost; ask += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one ask after another
    const asked = await logsOf(run);
    lines.push(...asked.lines);
    if (!textOf(asked.lines).includes("brain.recall.without_meaning")) {
      return { value: asked.value, lines };
    }
  }
  throw new Error(
    `"${name}" recalled without meaning ${meaningAsksMost} times in a row: its question embedder never answered in time`
  );
};

/** `person`'s own store, as core names it. */
export const ownStoreOf = (person: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${person}`);

/** Most alarms a person's own store may take to embed what it holds. */
const settleAlarmsMost = 50;

/**
 * Runs each of `people`'s own stores' alarms until it sleeps, everything
 * it holds embedded: a store left to itself wakes on its own alarm, a
 * minute after a change, and embeds in the background, which a pass must
 * never straddle: its tick moves what a recall finds of the reader's own
 * between one question and the next (by meaning, their own passages come
 * in only once they have vectors), and a pass compares those answers.
 * Fails, naming the store, when it still wakes after `settleAlarmsMost`
 * alarms, or sleeps with a passage of its own not embedded.
 */
export const settledOwnStores = async (
  people: readonly string[]
): Promise<void> => {
  for (const person of people) {
    let awake = true;
    for (let run = 0; awake && run < settleAlarmsMost; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one alarm after another
      awake = await runDurableObjectAlarm(ownStoreOf(person));
    }
    // oxlint-disable-next-line no-await-in-loop -- one store at a time
    const { embedding } = await ownStoreOf(person).workOverview();
    const done =
      embedding.chunks === 0 ||
      (embedding.rebuilt &&
        embedding.embedded + embedding.unembeddable === embedding.chunks);
    if (awake || !done) {
      throw new Error(
        `person:${person}'s own store wasn't embedded in ${settleAlarmsMost} alarms: ${JSON.stringify(embedding)}`
      );
    }
  }
};

/** The queue's clock for the ticks `allEmbedded` runs: only forward. */
const clock = { at: Date.now() };

/** Most ticks the shared store may take to embed. */
const embedTicksMost = 50;

/**
 * Each of `people`'s own stores settled (`settledOwnStores`), then the
 * shared store ticked, as core's clock does, until everything it holds is
 * embedded, nothing waits and no erasure is under way: the shared store's
 * embedding then.
 */
export const allEmbedded = async (
  people: readonly string[]
): Promise<WorkOverview["embedding"]> => {
  await settledOwnStores(people);
  for (let ticks = 0; ticks < embedTicksMost; ticks += 1) {
    clock.at = Math.max(clock.at, Date.now()) + 60_000;
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time, as core's clock
    await workBrain(env, new Date(clock.at), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- read after each tick
    const { embedding, waiting, erasing } = await brainWorkOverview(env);
    if (
      embedding.rebuilt &&
      embedding.embedded + embedding.unembeddable === embedding.chunks &&
      waiting.length === 0 &&
      erasing === 0
    ) {
      return embedding;
    }
  }
  throw new Error(`Not everything was embedded in ${embedTicksMost} ticks`);
};

/**
 * How many passages the current versions of `sources` hold in the shared
 * store, and how many of them have a vector: read from its storage, as
 * the store's overview counts only the whole store.
 */
export const embeddedOf = async (
  sources: readonly SourceRef[]
): Promise<{ chunks: number; embedded: number }> =>
  await runInDurableObject(
    inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
    (_instance, state) =>
      state.storage.sql
        .exec<{ chunks: number; embedded: number }>(
          `SELECT count(*) AS chunks,
          count(DISTINCT vector_codes.chunk) AS embedded
        FROM source_versions
        JOIN current_versions
          ON current_versions.version_row = source_versions.row
        JOIN chunks ON chunks.version_row = source_versions.row
        LEFT JOIN vector_codes ON vector_codes.chunk = chunks.row
        WHERE source_versions.source IN (SELECT value FROM json_each(?))`,
          JSON.stringify(sources.map(({ producer, id }) => `${producer}:${id}`))
        )
        .one()
  );

/**
 * Each of `people`'s own stores settled (`settledOwnStores`), then the
 * shared store ticked, as core's clock does, until every passage of the
 * current versions of `sources` has a vector: as `allEmbedded`, for a test
 * whose store still holds work earlier tests of its file left waiting.
 */
export const embeddedThrough = async (
  people: readonly string[],
  sources: readonly SourceRef[]
): Promise<void> => {
  await settledOwnStores(people);
  for (let ticks = 0; ticks < embedTicksMost; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read before each tick
    const { chunks, embedded } = await embeddedOf(sources);
    if (embedded === chunks) {
      return;
    }
    clock.at = Math.max(clock.at, Date.now()) + 60_000;
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time, as core's clock
    await workBrain(env, new Date(clock.at), noProducers);
  }
  throw new Error(`Not every source was embedded in ${embedTicksMost} ticks`);
};

/** Each of `among`'s answers by meaning (`recalledByMeaning`), and every line written. */
const askedEachByMeaning = async (
  among: readonly [string, Probe][],
  probing: Probing
): Promise<{ value: [string, Answer[]][]; lines: unknown[] }> => {
  const value: [string, Answer[]][] = [];
  const lines: unknown[] = [];
  for (const [name, probe] of among) {
    stopIfEnded();
    // In a pass that reads as the person, their own store embedded and
    // asleep before each surface asks: a probe before this one may have
    // changed it (an own source added or removed, a skill, a memory), and
    // its tick, on its own alarm, would then run between a marker's
    // question and its twin's, moving what a recall finds of their own for
    // one of them alone (GRA-2140). A pass as the company never reads
    // it, and holds that it is never even addressed.
    if (probing.personal) {
      // oxlint-disable-next-line no-await-in-loop -- one surface at a time
      await settledOwnStores([probing.personId]);
    }
    // oxlint-disable-next-line no-await-in-loop -- one surface at a time
    const asked = await recalledByMeaning(
      name,
      async () => await probe(probing)
    );
    value.push([name, asked.value]);
    lines.push(...asked.lines);
  }
  return { value, lines };
};

/**
 * Calls every surface (or those `among`) as `probing`'s reader; what they
 * gave away, in their answers or in the console. `inRecall` is forbidden
 * in what the recall surfaces answer too: instruction files, which no
 * recall finds, the reader's own included. Each surface is asked by
 * meaning (`recalledByMeaning`).
 */
export const findingsOf = async (
  pass: string,
  probing: Probing,
  forbidden: Readonly<Record<string, string>>,
  {
    among = surfaces,
    inRecall = {},
    before,
  }: {
    among?: readonly [string, Probe][];
    inRecall?: Readonly<Record<string, string>>;
    /** Each surface's answers before the hidden sources were added (`answersOf`). */
    before?: ReadonlyMap<string, readonly Answer[]>;
  } = {}
): Promise<Finding[]> => {
  // Every pass asks by meaning: one held to before compares whole
  // answers, and one held to the twins compares them apart from what
  // meaning found, whose cut still moves when only one of a pair went
  // without meaning.
  const { value: answered, lines } = await askedEachByMeaning(among, probing);
  return [
    ...answered.flatMap(([name, answers]) =>
      findingsIn(
        answers,
        recallSurfaces.has(name) ? { ...forbidden, ...inRecall } : forbidden,
        before?.get(name)
      ).map((found) => ({ pass, in: name, found }))
    ),
    // Answers by meaning are held to their answers before, never to the
    // twins': a surface not named in `meaningSurfaces`, and with no before
    // here, would be held to its markers alone.
    ...answered.flatMap(([name, answers]) =>
      answers.some(({ byMeaning }) => byMeaning) &&
      !meaningSurfaces.has(name) &&
      before?.get(name) === undefined
        ? [
            {
              pass,
              in: name,
              found: "answers by meaning, but isn't in meaningSurfaces",
            },
          ]
        : []
    ),
    ...markersIn(lines, forbidden).map((found) => ({
      pass,
      in: "logs",
      found,
    })),
  ];
};

/** Each of `among`'s answers as `probing`'s reader, by surface: a `before` for `findingsOf`. */
export const answersOf = async (
  probing: Probing,
  among: readonly [string, Probe][]
): Promise<Map<string, Answer[]>> => {
  const { value } = await askedEachByMeaning(among, probing);
  return new Map(value);
};

export const join = async (teamId: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .insert(teamMembers)
    .values({ id: crypto.randomUUID(), teamId, userId, createdAt: new Date() });
};

export const leave = async (teamId: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
};

/** A team of the organization, with `members`. */
export const newTeam = async (...members: string[]): Promise<string> => {
  const id = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await join(id, userId);
  }
  return id;
};

/**
 * Every version of `sources` a probe asks of: the first three, those past
 * a source's last as missing as any.
 */
export const everyVersionOf = (...sources: SourceRef[]) =>
  sources.flatMap((source) =>
    [1, 2, 3].map((version) => ({ source, version }))
  );

/** The shared store, as core reaches it. */
export const sharedStore = () =>
  inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** A source of its own, as an upload names it. */
export const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

export const add = async (
  text: string,
  readers: SourceReaders,
  source: SourceRef = newSource()
): Promise<SourceRef> => {
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/** A source's key, as the Brain names it. */
const keyOf = ({ producer, id }: SourceRef): string => `${producer}:${id}`;

/**
 * What `reader`'s recall of `question` in their own chat hands over, asked
 * by meaning as a pass asks (`recalledByMeaning`): whether their own store
 * changed it (`fromOwn`), and whether it hands over an item of a source.
 */
export const ownedRecallOf = async (
  reader: string,
  question: string
): Promise<{ fromOwn: boolean; hands: (source: SourceRef) => boolean }> => {
  const {
    value: { pack, fromOwn },
  } = await recalledByMeaning(
    "core recallOwnedAs",
    async () =>
      await recallOwnedAs(env, reader, {
        personal: true,
        question,
        budget: { tokens: recallBudgetMax },
      })
  );
  const handed = new Set(pack.items.map(({ source }) => keyOf(source)));
  return { fromOwn, hands: (source) => handed.has(keyOf(source)) };
};

/**
 * `words`, each split in two: a passage of them holds none of the words,
 * and meaning still finds their pieces in it.
 */
export const split = (words: readonly string[]): string =>
  words.map((word) => `${word.slice(0, 7)} ${word.slice(7)}`).join(" ");

/**
 * What `reader` may read nearest a question of `markers`, and nothing
 * else near it: a passage of their own, with `sharedWord`, and
 * `recallLimit - 1` of the team `teamId`, each the markers split
 * (`split`). Every place recall takes by meaning for the markers is
 * theirs to read, their own passage among them (`fromOwn`), so anything
 * hidden that took one would move their answer.
 */
export const nearestReadable = async (
  reader: string,
  teamId: string,
  markers: readonly string[],
  sharedWord: string
): Promise<{ own: SourceRef; team: SourceRef[] }> => ({
  own: await add(`${sharedWord} ${split(markers)}`, {
    kind: "owner",
    personId: reader,
  }),
  team: await Promise.all(
    Array.from(
      { length: recallLimit - 1 },
      async () => await add(split(markers), { kind: "team", teamId })
    )
  ),
});

/** What a read answered: its value, or its error's message. */
export const answerOf = async (
  read: () => Promise<unknown>
): Promise<string> => {
  try {
    return textOf(await read());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * What `personId` recalls for `question` by its words and exact parts:
 * each chunk's text. What also comes back by meaning is whatever else
 * they may read nearest the question; that none of it is hidden from them
 * is the passes' to show (`findingsOf`), as every hidden passage holds a
 * marker.
 */
export const textsFor = async (
  personId: string,
  question: string
): Promise<string[]> => {
  const { items } = await recallAs(env, personId, {
    personal: true,
    question,
    budget: { tokens: recallBudgetMax },
  });
  return items.flatMap(({ text, found }) =>
    found === "meaning" ? [] : [text]
  );
};

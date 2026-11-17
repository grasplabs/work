import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { requestGranted } from "./apps.ts";
import { brainSurfaces, textOf } from "./brain-next-surfaces.ts";
import type { Answer, Probe, Probing } from "./brain-next-surfaces.ts";
import type { Idp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

/**
 * What the marker test's files share (brain-next-leaks.test.ts and the
 * files beside it): the surfaces, how a pass finds what an answer, a log
 * line or a prompt gives away (`findingsOf`), and the ways a test adds,
 * reads and moves people between teams. Stateless: a test file's own
 * state (its IdP, a grant made once) stays in the file.
 */

/**
 * A word nothing else holds: 64 random bits. Short, as a pass asks every
 * marker it may not read at once, in a question and in a name of the
 * memory probes' fixture (brain-next-surfaces.ts), each with its limit.
 */
export const markerWord = (): string =>
  `m${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

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
]);

/** Whether `value` is an object with keys. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `value` without what recall found by meaning: every list of `items`
 * without those found by meaning, the rest of them in an order of their
 * own (a passage found by words is ranked by its meaning too, so the
 * order among them follows the question's meaning). Everything else as it
 * is.
 */
const apartFromMeaning = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(apartFromMeaning);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) =>
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
 * entity, the memories, what was not found, `fromOwn` and whether the
 * budget cut it short must be the twins'. Two packs both cut short are
 * held to their markers alone: which passages a short budget keeps
 * follows their order, and that follows the question's meaning. The test
 * that answers "by meaning exactly as before anything the reader may not
 * read was added" holds them to non-interference, for each shape of
 * reader core builds (`readerOf`): a person in a team with their own
 * note, a team-mate to whom that note is hidden, a person in no team (an
 * admin with nothing of their own), the company alone (an App's or a
 * workflow's code, and a turn others read), the company with a team an
 * App's grant names, and teams with no person (a chat's code).
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

/** Each of `among`'s answers by meaning (`recalledByMeaning`), and every line written. */
const askedEachByMeaning = async (
  among: readonly [string, Probe][],
  probing: Probing
): Promise<{ value: [string, Answer[]][]; lines: unknown[] }> => {
  const value: [string, Answer[]][] = [];
  const lines: unknown[] = [];
  for (const [name, probe] of among) {
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
  // meaning found, whose cut and `fromOwn` still move when only one of a
  // pair went without meaning.
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

/** `person`'s own store, as core names it. */
export const ownStoreOf = (person: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${person}`);

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

/**
 * Grants the chat agent the Brain permission, once for the file that
 * calls this (its binding name can be granted only once): a test file's
 * own, as each file starts from empty storage.
 */
export const chatAgentReadsBrainOnce = (idp: Idp): (() => Promise<void>) => {
  let grant: Promise<unknown> | undefined;
  return async () => {
    grant ??= (async () =>
      await requestGranted(idp, await signedInApi(idp, "admin"), {
        subject: { type: "agent", agentId: chatAgentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      }))();
    await grant;
  };
};

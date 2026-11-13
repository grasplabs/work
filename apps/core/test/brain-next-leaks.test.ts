import {
  exactCandidatesMax,
  recallBudgetMax,
  recallLimit,
} from "@grasp-os/brain-next/contract";
import type { WorkOverview } from "@grasp-os/brain-next/contract";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { drainAuditOutboxes } from "../src/audit-outbox.ts";
import { organizationId } from "../src/auth/auth.ts";
import { memberOf } from "../src/auth/identity.ts";
import {
  brainExportsPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import {
  addInstructionFile,
  addSource,
  alarmHostOf,
  brainStaffReport,
  brainWorkOverview,
  eraseSource,
  erasePerson,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type {
  InstructionFile,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { selectSkillsFor } from "../src/brain-skills.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { instructionFilesFor } from "../src/instruction-files.ts";
import { saveUserMemory } from "../src/knowledge/memory.ts";
import { codeStep, says } from "./agent-chat.ts";
import { published, requestGranted } from "./apps.ts";
import { brainModules } from "./brain-next-modules.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import type { StoreCopy } from "./brain-next-store-copy.ts";
import {
  brainSurfaces,
  chatCodeRecallProbe,
  membersOf,
  textOf,
} from "./brain-next-surfaces.ts";
import type { Answer, Probe, Probing } from "./brain-next-surfaces.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider, testModel } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { carrying } from "./platform-providers.ts";
import { routed, signedInApi, signedInWithRole, unique } from "./sign-in.ts";
import {
  member as teamsMember,
  memberAnsweredBy,
  mentionIn,
  messageFrom,
  newGroup,
  onGroupRoster,
  post,
  reached,
  watched as teamsWatched,
} from "./teams-door.ts";
import {
  builder,
  definitionOf,
  ended,
  published as publishedWorkflow,
  start,
} from "./workflow-resource-runs-harness.ts";

// The marker test (GRA-1722): the gate every later Brain issue keeps
// green. Unique marker words are planted in sources a reader may not
// read: someone else's own, a team's they aren't in, one nobody is known
// to read, and the first version of one whose readers changed: narrowed
// away from the outsider (they could read that version, and no longer
// can), and so widened to the holder, who may read its current version
// but was never among the first one's readers. Then every surface (brain-next-surfaces.ts) is called as
// that reader, every way it answers, and:
//
// - no marker may be in anything that comes back (results, "nothing
//   found", every part of an error), in a console line written meanwhile,
//   or in any request that reached a model provider;
// - what the reader gets asking only of what they may not read must be
//   exactly what they get asking of words nothing holds, so no count,
//   note or field can tell hidden matches exist.
//
// The same runs again across a change in membership, which counts from
// the very next recall, and as a reader of everything but the source
// nobody may read.

const idp = mockIdp();

teamsWatched();

/** A word nothing else holds. */
const markerWord = (): string => `m${crypto.randomUUID().replaceAll("-", "")}`;

/** Something a pass found that it may not. */
interface Finding {
  /** Who was reading. */
  pass: string;
  /** Where: a surface's answers, the logs, or the model prompts. */
  in: string;
  /** What: the marker found (by the source it was planted in), or why. */
  found: string;
}

/** The markers of `forbidden` that `found` holds, by name. */
const markersIn = (
  found: unknown,
  forbidden: Readonly<Record<string, string>>
): string[] => {
  const text = textOf(found).toLowerCase();
  return Object.entries(forbidden)
    .filter(([, marker]) => text.includes(marker))
    .map(([name]) => name);
};

/** Whether `name` is a method of the console. */
const isConsoleMethod = (name: string): name is keyof Console =>
  /^[a-z]/u.test(name) && typeof Reflect.get(console, name) === "function";

/** Every console line written while `run` runs, and what it returned. */
const logsOf = async <T>(
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
const surfaces: [string, Probe][] = brainSurfaces.flatMap(({ name, probes }) =>
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
const meaningSurfaces = new Set([
  "core recallAs",
  "core mergeRecalled",
  "sources search",
  "recall recallFor",
]);

/**
 * What a surface's answers give away: a forbidden marker, a hidden-only
 * answer unlike its answer to words nothing holds, an answer by meaning
 * unlike the same call's `before` the hidden sources were added, or no
 * answer worth the name (a probe that calls nothing, or only ever gets
 * errors, covers nothing). An answer by meaning (`Answer.byMeaning`) is
 * held to `before` alone, where a pass has one: a question of the markers
 * and one of their twins mean different things, so their packs differ by
 * meaning whatever is hidden. A pass without one (the marker test's
 * readers, and the restore, producers and export tests) holds `core
 * recallAs`, `core mergeRecalled` and `sources search` to their markers
 * alone: those tests add hidden sources before or beside what each reader
 * may read, so no moment holds a reader's own content without them. The
 * test that answers "by meaning exactly as before anything the reader may
 * not read was added" holds them to non-interference, for each shape of
 * reader core builds (`readerOf`): a person in a team with their own
 * note, a team-mate to whom that note is hidden, a person in no team (an
 * admin with nothing of their own), the company alone (an App's or a
 * workflow's code), and teams with no person (a chat that doesn't answer
 * its person alone, and a chat's code).
 */
const findingsIn = (
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
  return [...markersIn(answers, forbidden), ...unlike, ...moved, ...thin];
};

/**
 * The surfaces that read what the Brain holds, as a member: those probed
 * as a team-mate and an admin besides the full passes.
 */
const readingSurfaces = new Set([
  "core recallAs",
  "core readSourceVersionAs",
  "core readInstructionFilesAs",
  "core brainStaffReport",
  "core listSourcesAs",
  "core listVersionsAs",
  "sources list",
  "sources versions",
  "sources read",
  "sources search",
  "store listSources",
  "store listVersions",
  "store recall",
  "store find",
  "store readVersion",
  "store readCurrent",
  "store searchVectors",
]);

/** The surfaces that recall, where no instruction file may ever show. */
const recallSurfaces = new Set([
  "core recallAs",
  "store recall",
  "recall recallFor",
]);

/**
 * Calls every surface (or those `among`) as `probing`'s reader; what they
 * gave away, in their answers or in the console. `inRecall` is forbidden
 * in what the recall surfaces answer too: instruction files, which no
 * recall finds, the reader's own included.
 */
const findingsOf = async (
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
  const { value: answered, lines } = await logsOf(async () => {
    const found: [string, Answer[]][] = [];
    for (const [name, probe] of among) {
      // oxlint-disable-next-line no-await-in-loop -- one surface at a time
      found.push([name, await probe(probing)]);
    }
    return found;
  });
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

/**
 * The names of the Brain's stores core addressed while `run` ran (the
 * shared one, `brain`, and a person's own, `person:<id>`), and what it
 * returned: through the binding itself, so no way core names a store
 * goes unseen.
 */
const addressedBy = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; names: string[] }> => {
  const binding = env.BRAIN_STORE;
  const byName = vi.spyOn(binding, "getByName");
  const idsByName = vi.spyOn(binding, "idFromName");
  const byId = vi.spyOn(binding, "get");
  try {
    const value = await run();
    return {
      value,
      names: [
        ...byName.mock.calls.map(([name]) => name),
        ...idsByName.mock.calls.map(([name]) => name),
        ...byId.mock.calls.map(([id]) => id.name ?? `id:${String(id)}`),
      ],
    };
  } finally {
    byName.mockRestore();
    idsByName.mockRestore();
    byId.mockRestore();
  }
};

/** Reports `overview` as `person`'s own store's alarm does when its tick ends. */
const reportAs = async (
  person: string,
  overview: WorkOverview
): Promise<void> => {
  const host = await alarmHostOf(env, `person:${person}`);
  await host.report(overview);
};

/** Staff's totals of people's own stores. */
const ownTotals = async () => {
  const { ownStores } = await brainStaffReport(env);
  return ownStores;
};

/** `person`'s own store, as core names it. */
const ownStoreOf = (person: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${person}`);

/** Each of `among`'s answers as `probing`'s reader, by surface: a `before` for `findingsOf`. */
const answersOf = async (
  probing: Probing,
  among: readonly [string, Probe][]
): Promise<Map<string, Answer[]>> => {
  const answered = new Map<string, Answer[]>();
  for (const [name, probe] of among) {
    // oxlint-disable-next-line no-await-in-loop -- one surface at a time
    answered.set(name, await probe(probing));
  }
  return answered;
};

/** An item found by meaning, as `textOf` writes it: its source's id. */
const foundByMeaningPattern =
  /"source":\{"producer":"[^"]+","id":"(?<id>[^"]+)"\}[^{}]*?"found":"meaning"/gu;

/** How many items of `answers` were found by meaning. */
const foundByMeaning = (answers: Iterable<readonly Answer[]>): number =>
  [...answers]
    .flat()
    .reduce(
      (sum, { got }) => sum + textOf(got).split('"found":"meaning"').length - 1,
      0
    );

/** The sources of every item of `answers` found by meaning, by id. */
const meaningSourcesIn = (answers: Iterable<readonly Answer[]>): string[] =>
  [...answers]
    .flat()
    .flatMap(({ got }) =>
      Array.from(
        textOf(got).matchAll(foundByMeaningPattern),
        ({ groups }) => groups?.id ?? ""
      )
    );

/**
 * How many passages the current versions of `sources` hold in the shared
 * store, and how many of them have a vector: read from its storage, as
 * the store's overview counts only the whole store.
 */
const embeddedOf = async (
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

/** The queue's clock for ticks of this file: only forward. */
const clock = { at: Date.now() };

/** Most ticks the shared store, or a person's own, may take to embed. */
const embedTicksMost = 50;

/**
 * Runs each of `people`'s own stores' alarms until they sleep, then ticks
 * the shared store, as core's clock does, until everything it holds is
 * embedded, nothing waits and no erasure is under way: the shared store's
 * embedding then. Fails, naming the store, when a person's own store
 * still wakes after `embedTicksMost` alarms, or sleeps with a passage of
 * its own not embedded.
 */
const allEmbedded = async (
  people: readonly string[]
): Promise<WorkOverview["embedding"]> => {
  for (const person of people) {
    let awake = true;
    for (let run = 0; awake && run < embedTicksMost; run += 1) {
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
        `person:${person}'s own store wasn't embedded in ${embedTicksMost} alarms: ${JSON.stringify(embedding)}`
      );
    }
  }
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

const join = async (teamId: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .insert(teamMembers)
    .values({ id: crypto.randomUUID(), teamId, userId, createdAt: new Date() });
};

const leave = async (teamId: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
};

/** A team of the organization, with `members`. */
const newTeam = async (...members: string[]): Promise<string> => {
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
const everyVersionOf = (...sources: SourceRef[]) =>
  sources.flatMap((source) =>
    [1, 2, 3].map((version) => ({ source, version }))
  );

/** The shared store, as core reaches it. */
const sharedStore = () =>
  inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/**
 * A request of core's own page as the admin signed in on `cookie`: its
 * answer's JSON, whose `state` it holds.
 */
const adminRequest = async (
  cookie: string,
  path: string,
  body?: unknown
): Promise<{ id?: string; state?: string }> => {
  const response = await routed(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return z
    .looseObject({ id: z.string().optional(), state: z.string().optional() })
    .parse(await response.json());
};

/** Ticks the Brain until `path` no longer answers `state`: at most 20 ticks. */
const tickedPast = async (
  cookie: string,
  path: string,
  state: string
): Promise<string | undefined> => {
  for (let ticks = 0; ticks < 20; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await workBrain(env, new Date(), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await adminRequest(cookie, path);
    if (status.state !== state) {
      return status.state;
    }
  }
  throw new Error(`Still ${state} after 20 ticks`);
};

/** A source of its own, as an upload names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** Adds `text` as a version of `source` (a new one by default). */
const add = async (
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

/** What `personId` recalls for `question`: each chunk's text. */
const textsFor = async (
  personId: string,
  question: string
): Promise<string[]> => {
  const { items } = await recallAs(env, personId, {
    personal: true,
    question,
    budget: { tokens: recallBudgetMax },
  });
  return items.map(({ text }) => text);
};

describe(
  "the new Brain leaks nothing to a reader without access",
  { timeout: 120_000 },
  () => {
    /** The shared store before any test of this file added to it: empty. */
    let emptyStore: StoreCopy = { tables: [], triggers: [] };

    beforeAll(async () => {
      emptyStore = await copyOfStore();
    });

    it("has a probe for every member of every surface, and a surface for every module that reaches the Brain", () => {
      const names = new Set<string>(brainSurfaces.map(({ name }) => name));
      // Core's module and the store are the Brain itself; every module the
      // lint config lets import core's module names its own surface.
      const reaching: [string, string][] = [
        ["apps/core/src/brain-next.ts", "core"],
        ["BrainStore", "store"],
        ...Object.entries(brainModules),
      ];

      expect({
        // Pairs, not an object: two surfaces of one name are both compared.
        members: brainSurfaces.map(({ name, module }) => [
          name,
          membersOf(module).toSorted(),
        ]),
        unprobed: reaching.filter(([, name]) => !names.has(name)),
      }).toStrictEqual({
        members: brainSurfaces.map(({ name, probes }) => [
          name,
          Object.keys(probes).toSorted(),
        ]),
        unprobed: [],
      });
    });

    it("answers every question by meaning exactly as before anything the reader may not read was added and embedded, across an erasure and a change of membership", async () => {
      await answeringProvider(() => {});
      // Non-interference by meaning: the answers of the surfaces that
      // embed a question (`meaningSurfaces`) asked before anything hidden
      // existed, in a store holding nothing but what the reader may read,
      // all of it embedded, and again once the hidden sources are added
      // and embedded too, must be the same in every result, order, count
      // and note. The hidden passages hold exactly the questions asked, so
      // their vectors are the questions' own: the nearest there are, they
      // would take every place by meaning if they took any.
      //
      // The rule of its order: each shape of reader's answers before are
      // taken once everything it may read exists and is embedded, and
      // before the first thing hidden from it exists. Each shape, as core
      // builds it (`readerOf`), what it may read, and what it may not:
      // - the company alone (an App's or a workflow's code, `recall
      //   recallFor`, asked in the admin's pass and acting for the reader)
      //   and an admin in no team with nothing of their own: the passage
      //   for everyone; not the team's handbook, nor the reader's note,
      //   nor anything after;
      // - the reader's teams with no person (a chat that doesn't answer
      //   its person alone, `personal: false`, and a chat's code) and a
      //   team-mate: the passage for everyone and the handbook; not the
      //   reader's own note, nor anything after;
      // - the reader, in the team with their own note: all three; nothing
      //   after (an erased source, one narrowed away, the hidden ones).
      const { embedding: atStart } = await brainWorkOverview(env);
      expect(atStart.chunks).toBe(0);
      const [
        { userId: reader },
        { userId: holder },
        { userId: teamMate },
        { userId: admin },
      ] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "admin"),
      ]);
      const readersTeam = await newTeam(reader, teamMate);
      const secretTeam = await newTeam(holder);
      const sharedWord = `s${unique()}`;
      const markers = {
        "the holder's own source": markerWord(),
        "a team's source the reader isn't in": markerWord(),
        "a source nobody is known to read": markerWord(),
        "a source narrowed away from the reader": markerWord(),
        "a source erased": markerWord(),
        "a source narrowed away from the company": markerWord(),
      };
      const {
        "the holder's own source": ownerMarker,
        "a team's source the reader isn't in": teamMarker,
        "a source nobody is known to read": noneMarker,
        "a source narrowed away from the reader": narrowedMarker,
        "a source erased": erasedMarker,
        "a source narrowed away from the company": fromCompanyMarker,
      } = markers;
      const words = Object.values(markers);
      const probingAs = (personId: string, groups: string[]): Probing => ({
        personId,
        reader: { person: personId, groups },
        personal: true,
        sharedWord,
        markers: words,
        hiddenVersions: [],
        hiddenInstructionFiles: [],
        instructionGroups: [],
      });
      const probing = probingAs(reader, [`team:${readersTeam}`]);
      const asMate = probingAs(teamMate, [`team:${readersTeam}`]);
      const asAdmin = probingAs(admin, []);
      const asTeams: Probing = { ...probing, personal: false };
      const among = surfaces.filter(([name]) => meaningSurfaces.has(name));
      // Code's recall as an App reads as the company alone, whoever it
      // acts for: held in the admin's pass, whose before has nothing more.
      const amongMembers = among.filter(
        ([name]) => name !== "recall recallFor"
      );
      const teamsAmong = among.filter(([name]) => name.startsWith("core "));
      const chatCode: [string, Probe][] = [
        ["recall recallFor, as a chat's code", chatCodeRecallProbe],
      ];

      // What everyone in the company may read, so a reader of the company
      // alone has something by meaning hidden passages could crowd. Gone
      // again once the test ends, however it ends, so this file's later
      // tests, whose readers may read it, don't find it by meaning.
      const everyone = `Company handbook for everyone, ${sharedWord}`;
      const everyoneId = crypto.randomUUID();
      await sharedStore().addSource({
        source: `upload:${everyoneId}`,
        change: crypto.randomUUID(),
        text: everyone,
        access: { kind: "audience", group: "company" },
      });
      onTestFinished(async () => {
        await eraseSource(env, {
          source: { producer: "upload", id: everyoneId },
          readers: { kind: "none" },
          reason: "deleted",
        });
        await allEmbedded([]);
      }, 120_000);
      await allEmbedded([admin]);
      const adminBefore = await answersOf(asAdmin, among);
      // Code's recall as an App acting for the reader, who is in the team
      // already: as the company alone, so before the team's handbook.
      const appAmong = among.filter(([name]) => name === "recall recallFor");
      const appBefore = await answersOf(probing, appAmong);

      // The reader's team's, current after drafts: the team-mate's, the
      // reader's teams alone's and their chat's code's before.
      const handbookId = await add(`${sharedWord} draft 0`, {
        kind: "team",
        teamId: readersTeam,
      });
      await add(
        `The handbook for everyone who joins, ${sharedWord}`,
        { kind: "team", teamId: readersTeam },
        handbookId
      );
      await allEmbedded([teamMate]);
      const mateBefore = await answersOf(asMate, amongMembers);
      const teamsBefore = await answersOf(asTeams, teamsAmong);
      const chatCodeBefore = await answersOf(probing, chatCode);

      // The reader's own note, in their store: the reader's before.
      const readersNote = await add(`Notes on ${sharedWord} for the reader`, {
        kind: "owner",
        personId: reader,
      });
      const readable = await allEmbedded([reader]);
      const before = await answersOf(probing, amongMembers);

      // A source the reader may read now, embedded, then erased once the
      // hidden ones are embedded too; and one narrowed away from them once
      // embedded: neither may move anything once it is not theirs.
      const erased = await add(`${sharedWord} ${erasedMarker}`, {
        kind: "team",
        teamId: readersTeam,
      });
      const narrowed = await add(`Draft plan ${sharedWord} ${narrowedMarker}`, {
        kind: "team",
        teamId: readersTeam,
      });
      // And one everyone could read, embedded, then narrowed to the
      // holder's team: after every before, so no before holds it.
      const fromCompany: SourceRef = newSource();
      await sharedStore().addSource({
        source: `upload:${fromCompany.id}`,
        change: crypto.randomUUID(),
        text: `Policy for everyone ${sharedWord} ${fromCompanyMarker}`,
        access: { kind: "audience", group: "company" },
      });
      await allEmbedded([reader]);
      await add(
        `Final plan ${sharedWord} ${narrowedMarker}`,
        { kind: "team", teamId: secretTeam },
        narrowed
      );
      await add(
        `Policy for the board ${sharedWord} ${fromCompanyMarker}`,
        { kind: "team", teamId: secretTeam },
        fromCompany
      );
      // More hidden passages than recall takes by meaning, each exactly a
      // question the surfaces ask: the markers, and the shared word.
      const hiddenTexts = [words.join(" "), sharedWord];
      /** The holder's own copies, in their own store. */
      const holdersOwn = new Set<string>();
      /**
       * The shared store's hidden sources this test plants, by their refs:
       * what must be embedded when the answers are taken again, however
       * many sources a probe adds of its own. No probe of the surfaces
       * asked here adds a source any probed reader may read: one that did
       * would change their answers between before and after, rightly.
       */
      const planted: SourceRef[] = [erased, narrowed, fromCompany];
      for (const text of hiddenTexts) {
        for (let copy = 0; copy <= recallLimit; copy += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one source at a time
          planted.push(await add(text, { kind: "team", teamId: secretTeam }));
          // oxlint-disable-next-line no-await-in-loop -- one source at a time
          const own = await add(text, { kind: "owner", personId: holder });
          holdersOwn.add(own.id);
        }
      }
      planted.push(
        await add(`Board minutes ${sharedWord} ${teamMarker}`, {
          kind: "team",
          teamId: secretTeam,
        }),
        await add(`Unfiled note ${sharedWord} ${noneMarker}`, { kind: "none" })
      );
      await add(`Salary review ${sharedWord} ${ownerMarker}`, {
        kind: "owner",
        personId: holder,
      });
      const hidden = await allEmbedded([reader, holder]);
      const plantedEmbedded = await embeddedOf(planted);
      // The hidden passages are near: the holder, who may read them, gets
      // them by meaning for the markers' question.
      const holders = await recallAs(env, holder, {
        personal: true,
        question: words.join(" "),
        budget: { tokens: recallBudgetMax },
      });

      const asReader: Probing = {
        ...probing,
        // For the probes' contract alone: none of the surfaces asked here
        // reads it. A hidden version is caught by its marker and by the
        // comparison with before.
        hiddenVersions: everyVersionOf(erased, narrowed),
      };
      /** Each shape of reader held to their answers before, as `label`. */
      const everyShape = async (label: string): Promise<Finding[]> => {
        const { hiddenVersions } = asReader;
        const passes: [string, Probing, Map<string, Answer[]>, typeof among][] =
          [
            ["the reader", asReader, before, amongMembers],
            [
              "a team-mate",
              { ...asMate, hiddenVersions },
              mateBefore,
              amongMembers,
            ],
            [
              "an admin in no team",
              { ...asAdmin, hiddenVersions },
              adminBefore,
              among,
            ],
            [
              "the reader's teams alone",
              { ...asTeams, hiddenVersions },
              teamsBefore,
              teamsAmong,
            ],
            ["the reader's chat's code", asReader, chatCodeBefore, chatCode],
            [
              "code's recall as an App, for the reader",
              asReader,
              appBefore,
              appAmong,
            ],
          ];
        const found: Finding[] = [];
        for (const [who, as, was, surfacesOf] of passes) {
          found.push(
            // oxlint-disable-next-line no-await-in-loop -- one pass at a time
            ...(await findingsOf(`${who}, ${label}`, as, markers, {
              among: surfacesOf,
              before: was,
            }))
          );
        }
        return found;
      };
      // Erased once embedded: before the tick deletes it, and after.
      await eraseSource(env, {
        source: erased,
        readers: { kind: "team", teamId: readersTeam },
        reason: "deleted",
      });
      const whileErasing = await everyShape("an erasure under way");
      const afterErasure = await allEmbedded([reader, holder]);
      const erasedGone = await everyShape("the erasure done");
      // In the holder's team for one recall, then out again: the very next
      // answers are as before.
      await join(secretTeam, reader);
      const joinedTexts = await textsFor(reader, teamMarker);
      const joined = joinedTexts.includes(
        `Board minutes ${sharedWord} ${teamMarker}`
      );
      await leave(secretTeam, reader);
      const leftAgain = await everyShape("out of the team again");

      expect({
        findings: [...whileErasing, ...erasedGone, ...leftAgain],
        // Not empty: the reader's own passages were embedded, and found by
        // meaning, before; and every passage, the hidden ones among them,
        // was embedded when the answers were taken again.
        readable: readable.rebuilt && readable.embedded === readable.chunks,
        // Each shape's every surface found something by meaning before:
        // the passage for everyone, the handbook, the note, as it may.
        // Every surface named here is one the harness probes: a renamed
        // one fails here, never drops out of the passes.
        unprobed: [...meaningSurfaces].filter(
          (name) => !surfaces.some(([probed]) => probed === name)
        ),
        answeredBefore: Object.fromEntries(
          Object.entries({
            reader: before,
            teamMate: mateBefore,
            admin: adminBefore,
            teamsAlone: teamsBefore,
            chatCode: chatCodeBefore,
            appForReader: appBefore,
          }).map(([shape, answers]) => [
            shape,
            {
              surfaces: [...answers.keys()].toSorted(),
              withoutMeaning: [...answers]
                .filter(([, each]) => foundByMeaning([each]) === 0)
                .map(([name]) => name),
            },
          ])
        ),
        // The reader's own note, from their own store, by meaning.
        readersNoteByMeaning: meaningSourcesIn(before.values()).includes(
          readersNote.id
        ),
        hidden: hidden.rebuilt && hidden.embedded === hidden.chunks,
        planted: plantedEmbedded,
        afterErasure: afterErasure.rebuilt,
        // By meaning, from their own store, apart from the team's copies.
        holdersByMeaning: holders.items.some(
          ({ found, source }) =>
            found === "meaning" && holdersOwn.has(source.id)
        ),
        joined,
      }).toStrictEqual({
        findings: [],
        readable: true,
        unprobed: [],
        answeredBefore: {
          reader: {
            surfaces: ["core mergeRecalled", "core recallAs", "sources search"],
            withoutMeaning: [],
          },
          teamMate: {
            surfaces: ["core mergeRecalled", "core recallAs", "sources search"],
            withoutMeaning: [],
          },
          admin: {
            surfaces: [
              "core mergeRecalled",
              "core recallAs",
              "recall recallFor",
              "sources search",
            ],
            withoutMeaning: [],
          },
          teamsAlone: {
            surfaces: ["core mergeRecalled", "core recallAs"],
            withoutMeaning: [],
          },
          chatCode: {
            surfaces: ["recall recallFor, as a chat's code"],
            withoutMeaning: [],
          },
          appForReader: { surfaces: ["recall recallFor"], withoutMeaning: [] },
        },
        hidden: true,
        // One passage each, every one embedded.
        planted: {
          chunks: (recallLimit + 1) * hiddenTexts.length + 5,
          embedded: (recallLimit + 1) * hiddenTexts.length + 5,
        },
        afterErasure: true,
        readersNoteByMeaning: true,
        holdersByMeaning: true,
        joined: true,
      });
    });

    it("gives away no marker or hidden match in any answer, log line or prompt, across membership changes and to a reader of everything else", async () => {
      // A provider is connected, so anything that prompts a model reaches
      // the providers stub, which keeps every request it gets.
      await answeringProvider(() => {});
      // The holder builds Apps, so they can make the outsider a user of
      // two.
      const [holderApi, { userId: outsider }] = await Promise.all([
        signedInApi(idp, "builder"),
        signedInWithRole(idp, "user"),
      ]);
      const holder = holderApi.userId;
      const secretTeam = await newTeam(holder);
      const ownTeam = await newTeam(outsider);
      const sharedWord = `s${unique()}`;
      const markers = {
        "the holder's own source": markerWord(),
        "a team's source the outsider isn't in": markerWord(),
        "a source nobody is known to read": markerWord(),
        "a source narrowed away from the outsider": markerWord(),
        "a source narrowed to the holder alone": markerWord(),
        "the holder's instruction file": markerWord(),
        "another agent's instruction file": markerWord(),
        "an App's instruction file the outsider doesn't build": markerWord(),
        "an App's instruction file the outsider uses": markerWord(),
        "the holder's own skill": markerWord(),
      };
      const {
        "the holder's own source": ownerMarker,
        "a team's source the outsider isn't in": teamMarker,
        "a source nobody is known to read": noneMarker,
        "a source narrowed away from the outsider": narrowedMarker,
        "a source narrowed to the holder alone": toHolderMarker,
        "the holder's instruction file": holderFileMarker,
        "another agent's instruction file": agentFileMarker,
        "an App's instruction file the outsider doesn't build": appFileMarker,
        "an App's instruction file the outsider uses": usedAppFileMarker,
        "the holder's own skill": holderSkillMarker,
      } = markers;
      // Instruction files the outsider may not get: the holder's own,
      // another agent's than theirs, and an App's they don't build (one no
      // one made, so no one builds it).
      const holderFile: InstructionFile = { scope: "person", personId: holder };
      const agentFile: InstructionFile = {
        scope: "agent",
        agentId: `agent-${unique()}`,
      };
      const appFile: InstructionFile = {
        scope: "app",
        appId: crypto.randomUUID(),
      };
      // Two Apps the holder builds and the outsider uses, through core's
      // own records: one with a file, one without. A file is for an App's
      // builders, so the outsider gets neither.
      const { id: withFile } = await holderApi.api.apps.create({
        name: "Desk",
      });
      const { id: withoutFile } = await holderApi.api.apps.create({
        name: "Ledger",
      });
      for (const appId of [withFile, withoutFile]) {
        // Published, so its users may open it: a draft is its builders'.
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await published(appId);
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await holderApi.api.apps.members.add(appId, {
          type: "person",
          id: outsider,
          role: "user",
        });
      }
      const usedApps = { withFile, withoutFile };
      const usedAppFile: InstructionFile = { scope: "app", appId: withFile };
      const usedAppText = `Instructions ${sharedWord} ${usedAppFileMarker}`;
      for (const [file, marker] of [
        [holderFile, holderFileMarker],
        [agentFile, agentFileMarker],
        [appFile, appFileMarker],
        [usedAppFile, usedAppFileMarker],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        await addInstructionFile(env, {
          file,
          change: crypto.randomUUID(),
          text: `Instructions ${sharedWord} ${marker}`,
        });
      }
      const instructionMarkers = [
        holderFileMarker,
        agentFileMarker,
        appFileMarker,
        usedAppFileMarker,
      ];
      // The holder's own skill, named by its marker, written and asked to
      // be shared on the holder's own session: theirs alone, and the share
      // waits on admins, which the outsider isn't.
      const holderSkill = await holderApi.api.skills.save(
        `---\nname: ${holderSkillMarker}\ndescription: How to ${sharedWord} ${holderSkillMarker}\n---\nSteps ${sharedWord} ${holderSkillMarker}`
      );
      await holderApi.api.skills.share(holderSkill.name, holderSkill.version);
      // The holder's own chat lists it, and selects it for a task of it.
      await expect(
        selectSkillsFor(
          env,
          authoritySchema.parse({
            subject: { type: "agent", agentId: `agent-${unique()}` },
            onBehalfOf: holder,
            mode: "interactive",
          }),
          { personal: true },
          { task: holderSkillMarker }
        )
      ).resolves.toMatchObject([{ scope: "person", name: holderSkillMarker }]);
      // No recall ever finds an instruction file, a reader's own included.
      const inRecall = {
        "the holder's instruction file": holderFileMarker,
        "another agent's instruction file": agentFileMarker,
        "an App's instruction file the outsider doesn't build": appFileMarker,
        "an App's instruction file the outsider uses": usedAppFileMarker,
      };
      const instructionGroups = [
        "company",
        ...[withFile, withoutFile, appFile.appId].map((id) => `app:${id}`),
      ];
      const ownerIds = [
        await add(`Salary review ${sharedWord} ${ownerMarker}`, {
          kind: "owner",
          personId: holder,
        }),
      ];
      const teamSource = `Board minutes ${sharedWord} ${teamMarker}`;
      const teamId = await add(teamSource, {
        kind: "team",
        teamId: secretTeam,
      });
      const noneId = await add(`Unfiled note ${sharedWord} ${noneMarker}`, {
        kind: "none",
      });
      // More marked matches than a recall returns, each shorter than the
      // outsider's own, so hidden ones would crowd it out if they took
      // places.
      for (let index = 0; index <= 10; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        const id = await add(`${sharedWord} ${ownerMarker}`, {
          kind: "owner",
          personId: holder,
        });
        ownerIds.push(id);
      }
      // More hidden chunks holding a marker than the exact way checks of
      // a part: its cap counts only what the reader may read, so a marker
      // the reader asks for is still not found, as its twin is. They hold
      // an ID the outsider's own longer chunk holds too: ranked past the
      // hidden ones, it would be missed if the cap counted them.
      // An ID by the exact way's rule (exact.ts: a letter and two digits
      // or more), whatever the random part draws: eight hex characters
      // hold fewer than two digits about once in 180 draws, and then the
      // ID was a word, found "words" instead of "exact".
      const capId = `CAP-42-${unique()}`;
      for (let index = 0; index <= exactCandidatesMax; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await add(`Copy ${index} ${ownerMarker} ${capId}`, {
          kind: "owner",
          personId: holder,
        });
      }
      const capped = `The outsider's own, much longer than any copy: ${capId}.`;
      await add(capped, { kind: "owner", personId: outsider });
      // The outsider's own source, with more earlier versions than a
      // recall returns, each holding the shared word and shorter than the
      // current one: superseded, they may neither show nor take its place.
      const handbookId = await add(`${sharedWord} draft 0`, {
        kind: "team",
        teamId: ownTeam,
      });
      for (let draft = 1; draft <= 11; draft += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one version at a time
        await add(
          `${sharedWord} draft ${draft}`,
          { kind: "team", teamId: ownTeam },
          handbookId
        );
      }
      const handbook = `The handbook for everyone who joins the team, ${sharedWord}`;
      await add(handbook, { kind: "team", teamId: ownTeam }, handbookId);
      // First for the outsider's own team, the marker in that version only;
      // then narrowed to a team of the holder alone. Its first version is neither
      // the outsider's now (taken off) nor ever the holder's (not among its
      // readers), though the holder reads the current one. A source keeps
      // its kind of readers, so both versions are in the shared store.
      // Added two hours ago, by a clock faked in this isolate, which the
      // store shares: the final version, added now, comes an hour after
      // `whileDraft` whatever the machine's speed. As of then, the
      // outsider was among the draft's readers, and is still, but not
      // among the current version's.
      const hourMs = 3_600_000;
      const draftAt = Date.now() - 2 * hourMs;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(draftAt);
      let narrowedId: SourceRef;
      try {
        narrowedId = await add(`Draft plan ${sharedWord} ${narrowedMarker}`, {
          kind: "team",
          teamId: ownTeam,
        });
      } finally {
        vi.useRealTimers();
      }
      const whileDraft = new Date(draftAt + hourMs);
      const holdersTeam = await newTeam(holder);
      await add(
        `Final plan ${sharedWord}`,
        { kind: "team", teamId: holdersTeam },
        narrowedId
      );
      // First for the outsider's own team, then narrowed to the holder
      // alone: refused, as a source keeps the readers it was first added
      // for, so the version for the holder alone is kept nowhere.
      const toHolder = await add("Shared plan for the quarter", {
        kind: "team",
        teamId: ownTeam,
      });
      const narrowedToHolder = await add(
        `Plan for the holder ${sharedWord} ${toHolderMarker}`,
        { kind: "owner", personId: holder },
        toHolder
      ).then(
        () => "added",
        () => "refused"
      );

      // The markers are there to find for those who may read them.
      await expect(textsFor(holder, teamMarker)).resolves.toStrictEqual([
        teamSource,
      ]);
      await expect(
        textsFor(holder, `salary ${ownerMarker}`)
      ).resolves.toContain(`Salary review ${sharedWord} ${ownerMarker}`);
      // What the outsider finds by the shared word: their own source, past
      // the marked ones.
      const outsiderFinds = await textsFor(outsider, sharedWord);
      // And by the ID the hidden copies share: their own chunk, as exact.
      const { items: cappedItems } = await recallAs(env, outsider, {
        personal: true,
        question: capId,
        budget: { tokens: recallBudgetMax },
      });
      const cappedFinds = cappedItems.map(({ text, found }) => ({
        text,
        found,
      }));

      // Every store core addresses while anyone but the holder reads, or
      // while the holder recalls as an App does: never the holder's own.
      const addressed: string[] = [];
      const watched = async (
        ...args: Parameters<typeof findingsOf>
      ): Promise<Finding[]> => {
        const { value, names } = await addressedBy(
          async () => await findingsOf(...args)
        );
        addressed.push(...names);
        return value;
      };

      const asOutsider = (groups: string[]): Probing => ({
        personId: outsider,
        reader: { person: outsider, groups: groups.map((id) => `team:${id}`) },
        personal: true,
        sharedWord,
        markers: [
          ownerMarker,
          teamMarker,
          noneMarker,
          narrowedMarker,
          toHolderMarker,
          ...instructionMarkers,
          holderSkillMarker,
        ],
        hiddenVersions: everyVersionOf(...ownerIds, teamId, noneId, narrowedId),
        hiddenInstructionFiles: [holderFile, agentFile, appFile, usedAppFile],
        hiddenSkills: [holderSkillMarker],
        usedApps,
        instructionGroups,
        moments: [whileDraft],
      });
      const first = await watched(
        "the outsider",
        asOutsider([ownTeam]),
        markers,
        { inRecall }
      );

      // Joining the team counts from the very next recall: its source is
      // theirs to read, and nothing else is.
      await join(secretTeam, outsider);
      const joinedFinds = await textsFor(outsider, teamMarker);
      const { "a team's source the outsider isn't in": _joined, ...notJoined } =
        markers;
      const inTheTeam = await watched(
        "the outsider, in the team",
        {
          ...asOutsider([ownTeam, secretTeam]),
          markers: [
            ownerMarker,
            noneMarker,
            narrowedMarker,
            toHolderMarker,
            ...instructionMarkers,
          ],
          hiddenVersions: everyVersionOf(...ownerIds, noneId, narrowedId),
        },
        notJoined,
        { inRecall }
      );

      // Leaving counts from the very next recall too.
      await leave(secretTeam, outsider);
      const leftFinds = await textsFor(outsider, teamMarker);
      const outAgain = await watched(
        "the outsider, out of the team again",
        asOutsider([ownTeam]),
        markers,
        { inRecall }
      );

      // Someone who may read everything else still never gets the source
      // nobody is known to read, nor the first version of the source widened
      // to them, which was never theirs.
      const asHolder = await findingsOf(
        "the holder",
        {
          personId: holder,
          reader: {
            person: holder,
            groups: [`team:${secretTeam}`, `team:${holdersTeam}`],
          },
          personal: true,
          sharedWord,
          markers: [noneMarker, narrowedMarker, agentFileMarker, appFileMarker],
          hiddenVersions: [
            ...everyVersionOf(noneId),
            { source: narrowedId, version: 1 },
          ],
          // Their own instruction file is theirs, and so are the Apps'
          // they build.
          hiddenInstructionFiles: [agentFile, appFile],
          instructionGroups,
          moments: [whileDraft],
        },
        {
          "a source nobody is known to read": noneMarker,
          "a source narrowed away from the outsider": narrowedMarker,
          "another agent's instruction file": agentFileMarker,
          "an App's instruction file the outsider doesn't build": appFileMarker,
        },
        { inRecall }
      );
      // Code's recall from an App or a workflow reads only what everyone
      // in the company may: no person, no team. So nothing team-only
      // reaches it even for someone in that team, nothing of the
      // holder's own, and their own store is never addressed.
      const holderThroughCode = await watched(
        "the holder, through code's recall",
        {
          personId: holder,
          reader: { person: holder, groups: [`team:${secretTeam}`] },
          personal: false,
          sharedWord,
          markers: [ownerMarker, teamMarker, noneMarker, narrowedMarker],
          hiddenVersions: everyVersionOf(...ownerIds, teamId, noneId),
          hiddenInstructionFiles: [agentFile, appFile],
          instructionGroups,
          moments: [whileDraft],
        },
        {
          "the holder's own source": ownerMarker,
          "a team's source, though the holder is in the team": teamMarker,
          "a source nobody is known to read": noneMarker,
          "a source narrowed away from the outsider": narrowedMarker,
        },
        {
          among: surfaces.filter(([name]) => name.startsWith("recall ")),
          inRecall,
        }
      );

      // Recalling as an App does (`personal: false`), the holder finds
      // nothing of what is theirs alone: it is in their own store, which
      // that recall never addresses.
      const asApp = await watched(
        "the holder, recalling as an App does",
        {
          personId: holder,
          reader: {
            person: holder,
            groups: [`team:${secretTeam}`, `team:${holdersTeam}`],
          },
          personal: false,
          sharedWord,
          markers: [ownerMarker],
          hiddenVersions: [],
          hiddenInstructionFiles: [],
          instructionGroups,
          moments: [whileDraft],
        },
        { "the holder's own source": ownerMarker },
        { among: surfaces.filter(([name]) => name === "core recallAs") }
      );

      // A team-mate of the holder's, and an admin, through every surface
      // that reads: nothing of the holder's own reaches them.
      const [{ userId: teamMate }, { userId: admin }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "admin"),
      ]);
      await join(secretTeam, teamMate);
      const reading = surfaces.filter(([name]) => readingSurfaces.has(name));
      const { "a team's source the outsider isn't in": _team, ...notTeams } =
        markers;
      const asTeamMate = await watched(
        "a team-mate of the holder's",
        {
          personId: teamMate,
          reader: { person: teamMate, groups: [`team:${secretTeam}`] },
          personal: true,
          sharedWord,
          markers: [
            ownerMarker,
            noneMarker,
            narrowedMarker,
            toHolderMarker,
            ...instructionMarkers,
          ],
          hiddenVersions: everyVersionOf(...ownerIds, noneId, narrowedId),
          hiddenInstructionFiles: [holderFile, agentFile, appFile, usedAppFile],
          instructionGroups,
          moments: [whileDraft],
        },
        notTeams,
        { among: reading, inRecall }
      );
      const asAdmin = await watched(
        "an admin",
        {
          personId: admin,
          reader: { person: admin, groups: [] },
          personal: true,
          sharedWord,
          markers: [
            ownerMarker,
            teamMarker,
            noneMarker,
            narrowedMarker,
            toHolderMarker,
            ...instructionMarkers,
          ],
          hiddenVersions: everyVersionOf(
            ...ownerIds,
            teamId,
            noneId,
            narrowedId
          ),
          hiddenInstructionFiles: [holderFile, agentFile, appFile, usedAppFile],
          instructionGroups,
          moments: [whileDraft],
        },
        markers,
        { among: reading, inRecall }
      );

      // The holder builds the App, so its file is theirs to get.
      const holderAppFiles = await instructionFilesFor(
        env,
        authoritySchema.parse({
          subject: { type: "agent", agentId: `agent-${unique()}` },
          onBehalfOf: holder,
          mode: "interactive",
        }),
        { conversation: "own", appId: withFile }
      );
      // And the outsider does use it: it is theirs to open.
      const outsiderMember = await memberOf(env.DB, outsider);
      const outsiderOpens =
        outsiderMember === undefined
          ? "not a member"
          : await appFor(env, outsiderMember, withFile, "user").then(
              () => "opens it",
              String
            );

      // Any request any provider got, whoever's key it carried.
      const prompted: Finding[] = [];
      for (const [name, marker] of Object.entries(markers)) {
        // oxlint-disable-next-line no-await-in-loop -- one marker at a time
        const carried = await carrying(marker);
        if (carried.length > 0) {
          prompted.push({
            pass: "every pass",
            in: "model prompts",
            found: name,
          });
        }
      }

      expect({
        findings: [
          ...first,
          ...inTheTeam,
          ...outAgain,
          ...asHolder,
          ...holderThroughCode,
          ...asApp,
          ...asTeamMate,
          ...asAdmin,
          ...prompted,
        ],
        narrowedToHolder,
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
        // The binding was watched: the shared store and the outsider's own
        // were addressed through it.
        othersAddressed: [
          addressed.includes("brain"),
          addressed.includes(`person:${outsider}`),
        ],
        outsiderFinds,
        cappedFinds,
        joinedFinds,
        leftFinds,
        holderAppFile: holderAppFiles.some(({ text }) => text === usedAppText),
        outsiderOpens,
      }).toStrictEqual({
        findings: [],
        narrowedToHolder: "refused",
        holdersStoreAddressed: false,
        othersAddressed: [true, true],
        outsiderFinds: [handbook],
        cappedFinds: [{ text: capped, found: "exact" }],
        joinedFinds: [teamSource],
        leftFinds: [],
        holderAppFile: true,
        outsiderOpens: "opens it",
      });
    });

    it("gives someone who isn't a member, or was one, nothing of the company's instruction files", async () => {
      await answeringProvider(() => {});
      // Every member may read the company's files, so they are probed as
      // someone who never was one, and someone an admin removed: the
      // surfaces that load, read and recall them.
      const [admin, former] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInWithRole(idp, "user"),
      ]);
      await admin.api.members.remove(former.userId);
      const marker = markerWord();
      const companyFiles: InstructionFile[] = [
        { scope: "company", name: "instructions" },
        { scope: "company", name: "facts" },
      ];
      for (const file of companyFiles) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        await addInstructionFile(env, {
          file,
          change: crypto.randomUUID(),
          text: `Company instructions ${marker}`,
        });
      }
      const forbidden = { "the company's instruction files": marker };
      const findings: Finding[] = [];
      for (const [pass, personId] of [
        ["someone who never was a member", `stranger-${crypto.randomUUID()}`],
        ["someone an admin removed", former.userId],
      ] as const) {
        findings.push(
          // oxlint-disable-next-line no-await-in-loop -- one pass at a time
          ...(await findingsOf(
            pass,
            {
              personId,
              reader: { person: personId, groups: [] },
              personal: true,
              sharedWord: `s${unique()}`,
              markers: [marker],
              hiddenVersions: [],
              hiddenInstructionFiles: companyFiles,
              instructionGroups: ["company"],
            },
            forbidden,
            {
              among: surfaces.filter(([name]) =>
                [
                  "instructions instructionFilesFor",
                  "store readCurrent",
                  "store recall",
                ].includes(name)
              ),
            }
          ))
        );
      }
      const prompted = await carrying(marker);

      expect({ findings, prompted }).toStrictEqual({
        findings: [],
        prompted: [],
      });
    });

    it("gives no surface anything erased, once the store is restored from a copy taken before the erasure", async () => {
      await answeringProvider(() => {});
      // The holder's own sources, under each producer's kind (an upload, a
      // chat, a run), their instruction file, and a team's source: each
      // erased, then a copy of
      // the store from before the erasures comes back. Every surface is
      // then probed as those who could read them before.
      const [{ userId: holder }, { userId: teamMate }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const team = await newTeam(holder, teamMate);
      const markers = {
        "the holder's own source": markerWord(),
        "a team's source": markerWord(),
        "the holder's upload": markerWord(),
        "the holder's chat turn": markerWord(),
        "the holder's run": markerWord(),
        "the holder's instruction file": markerWord(),
      };
      const {
        "the holder's own source": ownMarker,
        "a team's source": teamMarker,
        "the holder's upload": uploadMarker,
        "the holder's chat turn": chatMarker,
        "the holder's run": runMarker,
        "the holder's instruction file": fileMarker,
      } = markers;
      const sharedWord = `s${unique()}`;
      const own = await add(`Salary ${sharedWord} ${ownMarker}`, {
        kind: "owner",
        personId: holder,
      });
      const teamSource = await add(`Minutes ${sharedWord} ${teamMarker}`, {
        kind: "team",
        teamId: team,
      });
      const upload: SourceRef = { producer: "upload", id: crypto.randomUUID() };
      const chat: SourceRef = { producer: "chat", id: crypto.randomUUID() };
      const run: SourceRef = { producer: "run", id: crypto.randomUUID() };
      const holders: SourceReaders = { kind: "owner", personId: holder };
      await add(`Contract ${sharedWord} ${uploadMarker}`, holders, upload);
      await add(`Asked ${sharedWord} ${chatMarker}`, holders, chat);
      await add(`Run note ${sharedWord} ${runMarker}`, holders, run);
      const holderFile: InstructionFile = { scope: "person", personId: holder };
      await addInstructionFile(env, {
        file: holderFile,
        change: crypto.randomUUID(),
        text: `Instructions ${sharedWord} ${fileMarker}`,
      });
      const backup = await copyOfStore();

      // A chat and an upload deleted for good, a run past its retention,
      // the team's source deleted, and then the holder erased.
      const teamReaders: SourceReaders = { kind: "team", teamId: team };
      await eraseSource(env, {
        source: chat,
        readers: holders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: upload,
        readers: holders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: run,
        readers: holders,
        reason: "retention",
      });
      await eraseSource(env, {
        source: teamSource,
        readers: teamReaders,
        reason: "deleted",
      });
      // Their own store answers that it is still deleting until an add
      // under way could have written its file: as if that time had passed.
      await Promise.allSettled([
        erasePerson(env, { personId: holder, reason: "person_erased" }),
      ]);
      await ageOwnErasure(holder);
      await erasePerson(env, { personId: holder, reason: "person_erased" });
      await workBrain(env, new Date(), noProducers);
      await restoreStore(backup);

      const erased = [own, teamSource, upload, chat, run].flatMap((source) =>
        [1, 2].map((version) => ({ source, version }))
      );
      const asReader = (
        personId: string,
        hiddenInstructionFiles: InstructionFile[]
      ): Probing => ({
        personId,
        reader: { person: personId, groups: [`team:${team}`] },
        personal: true,
        sharedWord,
        markers: Object.values(markers),
        hiddenVersions: erased,
        hiddenInstructionFiles,
        instructionGroups: ["company"],
      });
      // Their own store was erased whole, and takes nothing from then on:
      // the surfaces that write a skill of theirs (and decide a share of
      // one) can only be refused for them, and are probed as the
      // team-mate.
      const holderWritesOwn = new Set([
        "instructions saveInstructionFile",
        "core addOwnSkill",
        "shares readSkill",
        "shares saveOwnSkill",
        "shares shareOwnSkill",
        "shares approveShare",
        "shares declineShare",
        "shares retireSkill",
      ]);
      const findings = [
        // Their own file is theirs to write again, and what they write
        // after an erasure is new: saving it is probed as the team-mate
        // only, so the holder's pass finds their erased file if it came
        // back, and nothing they wrote since.
        ...(await findingsOf(
          "the holder, after a restore",
          asReader(holder, []),
          markers,
          {
            among: surfaces.filter(([name]) => !holderWritesOwn.has(name)),
          }
        )),
        ...(await findingsOf(
          "a team-mate, after a restore",
          asReader(teamMate, [holderFile]),
          markers
        )),
      ];
      const carried = await Promise.all(Object.values(markers).map(carrying));
      const prompted = carried.flat();

      expect({ findings, prompted }).toStrictEqual({
        findings: [],
        prompted: [],
      });
    });

    it("gives away nothing core's producers handed over to whoever the producer would not let read it", async () => {
      // Planted through each producer, as core hands them over: a run that
      // ended for the person it acted for, and a turn of a person's own
      // chat (GRA-1805), its question and answer both marked (the question
      // alone is kept). Then core's
      // surfaces are probed as the outsider and as an admin, neither of
      // whom reads either.
      const [otherAdmin, { userId: outsider }, runner, chatter] =
        await Promise.all([
          signedInApi(idp, "admin"),
          signedInWithRole(idp, "user"),
          builder(),
          signedInApi(idp, "user"),
        ]);
      const sharedWord = `s${unique()}`;
      const markers = {
        "a run of someone else": markerWord(),
        "a question in someone else's chat": markerWord(),
        "an answer in someone else's chat": markerWord(),
      };
      const {
        "a run of someone else": runMarker,
        "a question in someone else's chat": askedMarker,
        "an answer in someone else's chat": answerMarker,
      } = markers;
      await answeringProvider(() => says(`${sharedWord} ${answerMarker}`));
      const chat = await chatter.api.chats.create("Questions");
      await workspace(env, personalWorkspaceId(chatter.userId)).ask(
        chatIdSchema.parse(chat.id),
        { text: `${sharedWord} ${askedMarker}?`, model: testModel }
      );
      const workflow = await publishedWorkflow(
        runner,
        definitionOf([], { value: { status: `${sharedWord} ${runMarker}` } })
      );
      const { runId } = await start(runner, workflow.id);
      await ended(runner, workflow.id, runId);
      // The turn reaches the queue once its Workspace's outbox drained.
      const turn = await vi.waitFor(
        async () => {
          await drainAuditOutboxes(env);
          await relayHandOvers(env);
          await workBrain(env, new Date(), producersOf(env));
          const { items } = await recallAs(env, chatter.userId, {
            personal: true,
            question: askedMarker,
            budget: { tokens: recallBudgetMax },
          });
          // The turn, whatever else everyone may read comes back first.
          const found = items.find(({ source }) => source.producer === "chat");
          if (found === undefined) {
            throw new Error("The chat's turn was never handed over");
          }
          return found.source;
        },
        { timeout: 15_000, interval: 200 }
      );

      const probing = (personId: string): Probing => ({
        personId,
        reader: { person: personId, groups: [] },
        personal: true,
        sharedWord,
        markers: Object.values(markers),
        hiddenVersions: everyVersionOf(
          { producer: "run", id: runId ?? "" },
          turn
        ),
        hiddenInstructionFiles: [],
        instructionGroups: [],
      });
      const among = surfaces.filter(([name]) => name.startsWith("core "));
      const findings = [
        ...(await findingsOf("the outsider", probing(outsider), markers, {
          among,
        })),
        ...(await findingsOf(
          "an admin who doesn't read it",
          probing(otherAdmin.userId),
          markers,
          { among }
        )),
      ];
      const runnerFinds = await textsFor(runner.userId, runMarker);
      // Of what the chatter finds, their chat's turns: the one.
      const { items: chatterItems } = await recallAs(env, chatter.userId, {
        personal: true,
        question: askedMarker,
        budget: { tokens: recallBudgetMax },
      });
      const chatterFinds = chatterItems.filter(
        ({ source }) => source.producer === "chat"
      );

      expect({
        findings,
        // The runner and the chatter do find theirs.
        runner: runnerFinds.length,
        chatter: chatterFinds.length,
      }).toStrictEqual({ findings: [], runner: 1, chatter: 1 });
    });

    it("never wakes or addresses one person's own store for another's activity, their store's own work or staff's report", async () => {
      const [{ userId: holder }, { userId: other }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const sharedWord = `s${unique()}`;
      await add(`Holder's own ${sharedWord}`, {
        kind: "owner",
        personId: holder,
      });
      const holderAlarm = async () =>
        await runInDurableObject(
          ownStoreOf(holder),
          async (_store, state) => await state.storage.getAlarm()
        );
      const before = await holderAlarm();

      const { names } = await addressedBy(async () => {
        // The other person's own source, kept, erased (work for their
        // store's alarm), recalled, their alarm run, the clock's tick of
        // the shared store, staff's report, and their erasure.
        const theirs = await add(`Other's own ${sharedWord}`, {
          kind: "owner",
          personId: other,
        });
        await textsFor(other, sharedWord);
        await eraseSource(env, {
          source: theirs,
          readers: { kind: "owner", personId: other },
          reason: "deleted",
        });
        await runDurableObjectAlarm(ownStoreOf(other));
        await workBrain(env, new Date(), noProducers);
        await brainStaffReport(env);
        await Promise.allSettled([
          erasePerson(env, { personId: other, reason: "person_erased" }),
        ]);
      });

      expect({
        holdersStoreAddressed: names.includes(`person:${holder}`),
        othersStoreAddressed: names.includes(`person:${other}`),
        holdersAlarm: await holderAlarm(),
      }).toStrictEqual({
        holdersStoreAddressed: false,
        othersStoreAddressed: true,
        holdersAlarm: before,
      });
    });

    it("puts a person's own content in no chat-app conversation, their direct message included, and answers that one to them alone", async () => {
      // Through Teams' door as Teams posts (channels/door.ts), each turn
      // answered by the fake provider behind connect, which keeps what
      // reached it. A person's own source reaches a model only in their
      // own chat in Grasp: not in a thread others read, nor, while
      // GRA-1821's decision is open, in their direct message, which the
      // chat app keeps too (workspace.ts, `answersAlone`). A thread others
      // read is never their own chat either: no USER.md of theirs, and
      // none of their own chat's tools, their connections first.
      const admin = await signedInApi(idp, "admin");
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId: chatAgentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      const depot = `d${unique()}`;
      const marker = markerWord();
      const userMarker = markerWord();
      const answered = `Your note says ${marker}.`;
      // Each turn runs code that says whether it holds connections, then
      // answers. The threads are asked first, then her direct message,
      // whose (scripted) answer alone carries the marker: found in a
      // thread or another's chat, it went astray.
      // What it returns ("held:" or "none:" then the marker) is put
      // together as it runs: the code's own text never holds it.
      const holdsConnections = codeStep(
        `export default async (self, env) => { let held = false; try { held = env.connections !== undefined; } catch {} return [held ? "held" : "none", "${marker}"].join(":"); };`
      );
      const ann = await teamsMember(
        idp,
        holdsConnections,
        says("Noted."),
        holdsConnections,
        says("Noted."),
        holdsConnections,
        says("Noted."),
        holdsConnections,
        says(answered)
      );
      const ben = await memberAnsweredBy(idp, ann.provider);
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: crypto.randomUUID(),
        text: `Depot ${depot} keeps Ann's own note ${marker}`,
        readers: { kind: "owner", personId: ann.userId },
      });
      const agent = { type: "agent" as const, agentId: chatAgentId };
      await saveUserMemory(
        env,
        actingFor(agent, ann.userId),
        await newChat(agent),
        { type: "own" },
        { text: `Call me ${userMarker}.`, ifVersion: 0 }
      );
      const question = `What about depot ${depot}?`;
      /** What reached the model for what `ask` posted. */
      const sentFor = async (ask: () => Promise<unknown>) => {
        const before = ann.provider.requests.length;
        await ask();
        const sent = JSON.stringify(
          ann.provider.requests.slice(before).map(({ body }) => body)
        );
        return {
          own: sent.includes(`Depot ${depot} keeps`),
          userMd: sent.includes(userMarker),
          connections: sent.includes(`held:${marker}`),
          ran: sent.includes(`:${marker}`),
        };
      };
      // A group chat whose roster holds Ann alone is still one others can
      // join: shared, as Teams names it.
      const alone = newGroup();
      await onGroupRoster(alone, [{ person: ann.teams }]);
      const withBen = newGroup();
      await onGroupRoster(withBen, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      const channel = `19:${unique()}@thread.tacv2`;
      await onGroupRoster(channel, [{ person: ann.teams }]);
      const threads = [alone, withBen, channel];

      const inThreads = [
        await sentFor(
          async () => await post(mentionIn(ann.teams, alone, question))
        ),
        await sentFor(
          async () => await post(mentionIn(ann.teams, withBen, question))
        ),
        await sentFor(
          async () =>
            await post(
              mentionIn(
                ann.teams,
                `${channel};messageid=${unique()}`,
                question,
                "channel"
              )
            )
        ),
      ];
      // Her direct message, after the threads: each message is judged as
      // it comes, so asking there first or after changes nothing.
      const inDirect = await sentFor(
        async () => await post(messageFrom(ann.teams, { text: question }))
      );
      const found = await textsFor(ann.userId, `depot ${depot}`);
      const postedIn = async (conversation: string) => {
        const { activities } = await reached(conversation);
        return JSON.stringify(activities).includes(marker);
      };

      expect({
        // Her own recall finds it: what the model got is no empty Brain.
        found: found.length,
        inThreads,
        inDirect,
        postedInThreads: await Promise.all(threads.map(postedIn)),
        postedInDirect: await postedIn(ann.teams.conversation),
        postedToBen: await postedIn(ben.teams.conversation),
      }).toStrictEqual({
        found: 1,
        inThreads: threads.map(() => ({
          own: false,
          userMd: false,
          connections: false,
          ran: true,
        })),
        // Her own chat on Teams: its tools and her USER.md, as on main
        // (knowledge/memory.ts); her own store, not while GRA-1821 is open.
        inDirect: { own: false, userMd: true, connections: true, ran: true },
        postedInThreads: [false, false, false],
        postedInDirect: true,
        postedToBen: false,
      });
    });

    it("tells staff the same totals of people's own stores whoever of them holds what", async () => {
      const [first, second] = [
        `person-${crypto.randomUUID()}`,
        `person-${crypto.randomUUID()}`,
      ];
      // An overview as a store that holds something reports it, with
      // `waiting` items and `parked` (one holding nothing has no row).
      const base = await ownStoreOf(first).workOverview();
      const holding = (waiting: number, parked: number) => ({
        ...base,
        holding: true,
        waiting:
          waiting === 0
            ? []
            : [
                {
                  kind: "embed",
                  count: waiting,
                  oldestAddedAt: new Date(1_000_000),
                },
              ],
        parkedCount: parked,
      });
      const before = await ownTotals();
      await reportAs(first, holding(5, 2));
      await reportAs(second, holding(0, 0));
      const oneHoldsAll = await ownTotals();
      await reportAs(first, holding(0, 0));
      await reportAs(second, holding(5, 2));
      const theOtherHoldsAll = await ownTotals();
      for (const person of [first, second]) {
        // oxlint-disable-next-line no-await-in-loop -- one person at a time
        await erasePerson(env, { personId: person, reason: "person_erased" });
      }

      expect({
        added: {
          stores: oneHoldsAll.stores - before.stores,
          waiting: oneHoldsAll.waiting - before.waiting,
          parked: oneHoldsAll.parked - before.parked,
        },
        same: theOtherHoldsAll,
      }).toStrictEqual({
        added: { stores: 2, waiting: 5, parked: 2 },
        same: oneHoldsAll,
      });
    });

    // Last: it empties the shared store, as a loss of its storage would.
    it("gives away nothing of a company's export once it is restored into an empty store, memories and entities among it (GRA-1840)", async () => {
      await answeringProvider(() => {});
      const [admin, { userId: outsider }, { userId: insider }] =
        await Promise.all([
          signedInWithRole(idp, "admin"),
          signedInWithRole(idp, "user"),
          signedInWithRole(idp, "user"),
        ]);
      const secretTeam = await newTeam(insider);
      const ownTeam = await newTeam(outsider, insider);
      const sharedWord = `s${unique()}`;
      const markers = {
        "a team's source the outsider isn't in": markerWord(),
        "a team's memory the outsider isn't in": markerWord(),
        "a memory drawn from that team's source": markerWord(),
      };
      const {
        "a team's source the outsider isn't in": sourceMarker,
        "a team's memory the outsider isn't in": memoryMarker,
        "a memory drawn from that team's source": drawnMarker,
      } = markers;
      const secret = `team:${secretTeam}`;
      const own = `team:${ownTeam}`;
      const teamSource = await add(
        `Board minutes ${sharedWord} ${sourceMarker}`,
        {
          kind: "team",
          teamId: secretTeam,
        }
      );
      // The store's key of it, as core names a source to the Brain.
      const key = `${teamSource.producer}:${teamSource.id}`;
      const marked = (marker: string) => ({
        key: "c",
        kind: "customer" as const,
        names: [`${sharedWord} ${marker}`],
        identifiers: [{ type: "ref" as const, value: `ref:${marker}` }],
      });
      await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: secret },
        entities: [marked(memoryMarker)],
        memories: [
          {
            about: "c",
            attribute: "status",
            value: memoryMarker,
            type: "fact",
            statement: `${sharedWord} ${memoryMarker}`,
            speaker: { kind: "system" },
            basis: { kind: "writer", writer: insider },
          },
        ],
      });
      // Readable by a team the outsider is in, but drawn from a source of
      // a team they aren't: theirs neither.
      const drawn = await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: own },
        entities: [marked(drawnMarker)],
        memories: [
          {
            about: "c",
            type: "fact",
            statement: `${sharedWord} ${drawnMarker}`,
            speaker: { kind: "system" },
            basis: {
              kind: "source",
              source: key,
              version: 1,
              quote: sharedWord,
            },
          },
        ],
        extracted: { source: key, version: 1 },
      });
      const { id = "" } = await adminRequest(
        admin.session,
        brainExportsPath,
        {}
      );
      const exported = await tickedPast(
        admin.session,
        `${brainExportsPath}?id=${id}`,
        "writing"
      );

      // The shared store's storage lost, its bucket kept: as it was
      // before anything was added.
      await restoreStore(emptyStore);
      const started = await adminRequest(admin.session, brainRestorePath, {
        exportId: id,
      });
      const restored = await tickedPast(
        admin.session,
        `${brainRestorePath}?id=${id}`,
        "running"
      );
      // What the export held came back, for whoever may read it.
      const insiders = await sharedStore().readMemories({
        entity: drawn.entities.c ?? "",
        reader: { person: insider, groups: [own, secret] },
      });

      const findings = await findingsOf(
        "the outsider, after a restore of an export",
        {
          personId: outsider,
          reader: { person: outsider, groups: [own] },
          personal: true,
          sharedWord,
          markers: Object.values(markers),
          hiddenVersions: everyVersionOf(teamSource),
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        markers
      );
      const carried = await Promise.all(Object.values(markers).map(carrying));

      expect({
        exported,
        started: started.state,
        restored,
        insiders: insiders.memories.map(({ statement }) => statement),
        findings,
        prompted: carried.flat(),
      }).toStrictEqual({
        exported: "done",
        started: "running",
        restored: "done",
        insiders: [`${sharedWord} ${drawnMarker}`],
        findings: [],
        prompted: [],
      });
    });
  }
);

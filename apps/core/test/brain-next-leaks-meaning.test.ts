import { recallBudgetMax, recallLimit } from "@grasp-os/brain-next/contract";
import type { WorkOverview } from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vite-plus/test";
import { z } from "zod";

import {
  brainExportsPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import {
  addInstructionFile,
  brainWorkOverview,
  eraseSource,
  recallAs,
  removeSource,
  workBrain,
} from "../src/brain-next.ts";
import type {
  InstructionFile,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { says } from "./agent-chat.ts";
import {
  markerWord,
  surfaces,
  meaningSurfaces,
  findingsOf,
  ownStoreOf,
  answersOf,
  recalledByMeaning,
  join,
  leave,
  newTeam,
  everyVersionOf,
  sharedStore,
  newSource,
  add,
  textsFor,
  chatAgentReadsBrainOnce,
} from "./brain-next-leaks-harness.ts";
import type { Finding } from "./brain-next-leaks-harness.ts";
import {
  asIfOlderLate,
  asIfOlderVersion,
  caughtUp,
  companyMemorySurfaces,
  contestedInRecall,
  currentIn,
  inStoreOf,
  judged,
  memorySurfaces,
  midPass,
  newWorld,
  outWord,
  ownMemorySurfaces,
  outReadsOf,
  remember,
  tablesHolding,
  transcriptOf,
  shownIn,
  textHolding,
  tick,
  unlikeTwin,
  wordRulesOf,
  writesOf,
} from "./brain-next-out-reads.ts";
import type { OutWorld } from "./brain-next-out-reads.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import type { StoreCopy } from "./brain-next-store-copy.ts";
import {
  chatCodeRecallProbe,
  markedDay,
  markedDayAsked,
  textOf,
} from "./brain-next-surfaces.ts";
import type { Answer, Probe, Probing } from "./brain-next-surfaces.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { carrying } from "./platform-providers.ts";
import { routed, signedInApi, signedInWithRole, unique } from "./sign-in.ts";
import {
  member as teamsMember,
  messageFrom,
  post,
  watched as teamsWatched,
} from "./teams-door.ts";

// The marker test (brain-next-leaks.test.ts), by meaning and for memories:
// answers that depend on a question's meaning, held to the same answers
// before anything the reader may not read existed; a company's export
// restored into an empty store; and memories out of use, which must reach
// no reader as current through any surface.

const idp = mockIdp();
teamsWatched();

/** Grants the chat agent the Brain permission, once for the file. */
const chatAgentReadsBrain = chatAgentReadsBrainOnce(idp);

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

/** Adds `text` as `world`'s next version. */
const version = async (
  world: OutWorld,
  text: string,
  readers: SourceReaders
) => {
  await add(text, readers, world.source);
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
      //   after (an erased source, a removed one, one narrowed away, the
      //   hidden ones).
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
        "a source removed": markerWord(),
        "a source narrowed away from the company": markerWord(),
      };
      const {
        "the holder's own source": ownerMarker,
        "a team's source the reader isn't in": teamMarker,
        "a source nobody is known to read": noneMarker,
        "a source narrowed away from the reader": narrowedMarker,
        "a source erased": erasedMarker,
        "a source removed": removedMarker,
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
      // hidden ones are embedded too; one removed then (its versions kept
      // as history, out of use); and one narrowed away from them once
      // embedded: none may move anything once it is not theirs.
      const erased = await add(`${sharedWord} ${erasedMarker}`, {
        kind: "team",
        teamId: readersTeam,
      });
      const removed = await add(`Old plan ${sharedWord} ${removedMarker}`, {
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
      // question the surfaces ask: the markers, the markers with the day
      // the probes ask of them (written as the passages they ask it of
      // write it), and the shared word.
      const datedText = `${words.join(" ")} ${markedDay}`;
      const hiddenTexts = [words.join(" "), datedText, sharedWord];
      /** The holder's own copies, in their own store. */
      const holdersOwn = new Set<string>();
      /** Of them, those mentioning the day. */
      const holdersDated = new Set<string>();
      /**
       * The shared store's hidden sources this test plants, by their refs:
       * what must be embedded when the answers are taken again, however
       * many sources a probe adds of its own. No probe of the surfaces
       * asked here adds a source any probed reader may read: one that did
       * would change their answers between before and after, rightly.
       */
      const planted: SourceRef[] = [erased, removed, narrowed, fromCompany];
      for (const text of hiddenTexts) {
        for (let copy = 0; copy <= recallLimit; copy += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one source at a time
          planted.push(await add(text, { kind: "team", teamId: secretTeam }));
          // oxlint-disable-next-line no-await-in-loop -- one source at a time
          const own = await add(text, { kind: "owner", personId: holder });
          holdersOwn.add(own.id);
          if (text === datedText) {
            holdersDated.add(own.id);
          }
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
      const { value: holders } = await recalledByMeaning(
        "the holder's recall",
        async () =>
          await recallAs(env, holder, {
            personal: true,
            question: words.join(" "),
            budget: { tokens: recallBudgetMax },
          })
      );
      // And by the day alone, written otherwise: the date way reaches the
      // copies that mention it.
      const { value: holdersDay } = await recalledByMeaning(
        "the holder's recall of the day",
        async () =>
          await recallAs(env, holder, {
            personal: true,
            question: `${markedDayAsked.day} ${markedDayAsked.month} ${markedDayAsked.year}`,
            budget: { tokens: recallBudgetMax },
          })
      );

      const asReader: Probing = {
        ...probing,
        // For the probes' contract alone: none of the surfaces asked here
        // reads it. A hidden version is caught by its marker and by the
        // comparison with before.
        hiddenVersions: everyVersionOf(erased, removed, narrowed),
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
      // Erased once embedded: before the tick deletes it, and after; and
      // the removed one with it.
      await eraseSource(env, {
        source: erased,
        readers: { kind: "team", teamId: readersTeam },
        reason: "deleted",
      });
      await removeSource(env, {
        source: removed,
        readers: { kind: "team", teamId: readersTeam },
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

      // What a member's recall answers through, each by meaning: a pack's
      // tokens (`core recalledTokens`) are a count, which names no way an
      // item was found, so it is held to before alone.
      const everyMember = [
        "core mergeRecalled",
        "core recallAs",
        "core recallOwnedAs",
        "core recallPassagesAs",
        "core recalledTokens",
        "sources search",
      ];
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
        // By its day, from their own store: a date is an exact part.
        holdersByDay: holdersDay.items.some(
          ({ found, source }) =>
            found === "exact" && holdersDated.has(source.id)
        ),
        joined,
      }).toStrictEqual({
        findings: [],
        readable: true,
        unprobed: [],
        answeredBefore: {
          reader: {
            surfaces: everyMember,
            withoutMeaning: ["core recalledTokens"],
          },
          teamMate: {
            surfaces: everyMember,
            withoutMeaning: ["core recalledTokens"],
          },
          admin: {
            surfaces: [...everyMember, "recall recallFor"].toSorted(),
            withoutMeaning: ["core recalledTokens"],
          },
          teamsAlone: {
            surfaces: everyMember.filter((name) => name.startsWith("core ")),
            withoutMeaning: ["core recalledTokens"],
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
          chunks: (recallLimit + 1) * hiddenTexts.length + 6,
          embedded: (recallLimit + 1) * hiddenTexts.length + 6,
        },
        afterErasure: true,
        readersNoteByMeaning: true,
        holdersByMeaning: true,
        holdersByDay: true,
        joined: true,
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

    /**
     * Out of use (GRA-1915): a memory whose source's current version no
     * longer says its quote is out, and must reach no reader as current
     * through any surface, while its control, a memory the same version
     * still says, does (brain-next-out-reads.ts). A reader of a team's
     * source reads alike in a world with what they may not read (a team's
     * memories of the same source, or its version) and in its twin
     * without, the two written on one clock.
     */
    const outNames = [
      "out",
      "keep",
      "hidden out",
      "hidden keep",
      "rival",
      "out contact",
      "keep contact",
      "reached by out contact",
      "reached by keep contact",
    ];

    /** The memories a reader of the team may read, as a rich world plants them. */
    const visibleNames = [
      "out",
      "keep",
      "rival",
      "out contact",
      "keep contact",
      "reached by out contact",
      "reached by keep contact",
    ];

    /** A reader in a team, someone in that team and a hidden one, and how the Brain reads each. */
    const outReaders = async () => {
      const [{ userId: reader }, { userId: both }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const team = await newTeam(reader, both);
      const hiddenTeam = await newTeam(both);
      return {
        reader,
        both,
        team,
        hiddenTeam,
        teamReaders: { kind: "team", teamId: team } satisfies SourceReaders,
        readerReads: { person: reader, groups: [`team:${team}`, "company"] },
        bothReads: {
          person: both,
          groups: [`team:${team}`, `team:${hiddenTeam}`, "company"],
        },
      };
    };

    type OutReaders = Awaited<ReturnType<typeof outReaders>>;

    /** A world on a new source of a team's, and its twin, on one clock. */
    const worldAndTwin = () =>
      [
        newWorld("shared", newSource(), outNames),
        newWorld("shared", newSource(), outNames),
      ] as const;

    /**
     * What `readers.reader` and the one in both teams read of `world` and
     * of `twin`, `versions` versions each: where each marker is current,
     * where the out one shows at all, and how the reader's reads differ
     * from the twin's.
     */
    const outcomeOf = async (
      readers: OutReaders,
      world: OutWorld,
      twin: OutWorld,
      versions: number
    ) => {
      const ours = await outReadsOf(
        readers.reader,
        readers.readerReads,
        world,
        versions
      );
      const theirs = await outReadsOf(
        readers.reader,
        readers.readerReads,
        twin,
        versions
      );
      const both = await outReadsOf(
        readers.both,
        readers.bothReads,
        world,
        versions
      );
      const marked = (name: string) => world.markers[name] ?? "";
      // The memories planted that state a marker of their own.
      const planted = Object.keys(world.memories).filter(
        (name) => name in world.markers
      );
      return {
        reader: {
          current: Object.fromEntries(
            visibleNames
              .filter((name) => planted.includes(name))
              .map((name) => [name, currentIn(ours, marked(name))])
          ),
          hidden: ["hidden out", "hidden keep"].flatMap((name) =>
            shownIn(ours, marked(name))
          ),
          unlikeTwin: await unlikeTwin(world, ours, twin, theirs),
        },
        both: Object.fromEntries(
          planted.map((name) => [name, currentIn(both, marked(name))])
        ),
        history: shownIn(ours, marked("out")),
        // What recall itself groups as contested, beside the page's.
        contestedInRecall: contestedInRecall(ours),
      };
    };

    /** Where a memory that is out shows to a reader of it: as history alone. */
    const historySurfaces = ["memories", "the Brain page's memories"];

    /**
     * The first version of each world for the team, saying both quotes,
     * and its memories, each in an add of its own, so a page or a card
     * orders them by when each was learned alone: the out one and its
     * control, and in a world with `hidden` a hidden team's two, with
     * `rich` a rival of the out one's one-value status in a writer's word
     * (which stays current), two contact relations, one out for good
     * (its quote no later version says) and one kept,
     * and a fact of each contact, which a reader reaches only along its
     * relation. Step by step, each step for every world before the next, so
     * the worlds' events come in the same order.
     */
    const plantFirst = async (
      readers: OutReaders,
      worlds: readonly { world: OutWorld; hidden: boolean }[],
      { rich = false }: { rich?: boolean } = {}
    ) => {
      const group = `team:${readers.team}`;
      const hiddenGroup = `team:${readers.hiddenTeam}`;
      const steps: ((world: OutWorld, hidden: boolean) => Promise<void>)[] = [
        async (world) => {
          await version(
            world,
            textHolding(world.depot, "out", "keep", "gone"),
            readers.teamReaders
          );
        },
        async (world) => {
          await remember(world, group, 1, {
            out: rich ? { quote: "out", attribute: "status" } : "out",
          });
        },
        async (world) => {
          await remember(world, group, 1, { keep: "keep" });
        },
        async (world, hidden) => {
          if (hidden) {
            await remember(world, hiddenGroup, 1, { "hidden out": "out" });
          }
        },
        async (world, hidden) => {
          if (hidden) {
            await remember(world, hiddenGroup, 1, { "hidden keep": "keep" });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              rival: { attribute: "status" },
            });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              "out contact": { quote: "gone", contact: "p1" },
            });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              "keep contact": { quote: "keep", contact: "p2" },
            });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              "reached by out contact": { quote: "keep", about: "p1" },
            });
            await remember(world, group, 1, {
              "reached by keep contact": { quote: "keep", about: "p2" },
            });
          }
        },
      ];
      for (const write of steps) {
        for (const { world, hidden } of worlds) {
          // oxlint-disable-next-line no-await-in-loop -- a step at a time, every world in it
          await write(world, hidden);
        }
      }
    };

    /** Each world's second version, at step 10: the out quote dropped. */
    const dropOut = async (readers: OutReaders, ...worlds: OutWorld[]) => {
      for (const world of worlds) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await version(
          world,
          textHolding(world.depot, "keep"),
          readers.teamReaders
        );
      }
    };

    /** Each world's first two versions and its memories (`plantFirst`, `dropOut`). */
    const outWorldOf = async (
      readers: OutReaders,
      worlds: readonly { world: OutWorld; hidden: boolean }[],
      options: { rich?: boolean } = {}
    ) => {
      await plantFirst(readers, worlds, options);
      await dropOut(readers, ...worlds.map(({ world }) => world));
    };

    /**
     * Two worlds whose memories are drawn from their first version once
     * the second is current, step by step: the out one and its control,
     * and the first world's hidden two.
     */
    const lateWorlds = async (
      readers: OutReaders,
      world: OutWorld,
      twin: OutWorld
    ) => {
      const group = `team:${readers.team}`;
      const hiddenGroup = `team:${readers.hiddenTeam}`;
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- a step at a time
        await version(
          each,
          textHolding(each.depot, "out", "keep"),
          readers.teamReaders
        );
      }
      await dropOut(readers, world, twin);
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- a step at a time
        await remember(each, group, 1, { out: "out" });
      }
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- a step at a time
        await remember(each, group, 1, { keep: "keep" });
      }
      await remember(world, hiddenGroup, 1, { "hidden out": "out" });
      await remember(world, hiddenGroup, 1, { "hidden keep": "keep" });
    };

    /** What every case expects once its memory is out: nothing current of it, its control current everywhere. */
    const outcomeOnceOut = {
      reader: {
        current: { out: [], keep: memorySurfaces },
        hidden: [],
        unlikeTwin: [],
      },
      both: {
        out: [],
        keep: memorySurfaces,
        "hidden out": [],
        "hidden keep": memorySurfaces,
      },
      history: historySurfaces,
      contestedInRecall: [],
    };

    it("gives no reader a memory current once its source's current version drops its quote, not as a contested value or a relation either, and every reader it again once a later one says it, whatever they may not read", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      await plantFirst(
        readers,
        [
          { world, hidden: true },
          { world: twin, hidden: false },
        ],
        { rich: true }
      );
      // Before: the out one's status contests its rival's.
      const before = await outReadsOf(
        readers.reader,
        readers.readerReads,
        world,
        1
      );
      await dropOut(readers, world, twin);
      const once = await outcomeOf(readers, world, twin, 2);
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await version(
          each,
          textHolding(each.depot, "out", "keep"),
          readers.teamReaders
        );
      }
      const again = await outcomeOf(readers, world, twin, 3);
      // What the whole company may read, through an App's read too.
      const company = newWorld("shared", newSource(), outNames);
      const everyone: SourceReaders = { kind: "everyone" };
      await version(
        company,
        textHolding(company.depot, "out", "keep"),
        everyone
      );
      await remember(company, "company", 1, { out: "out" });
      await remember(company, "company", 1, { keep: "keep" });
      await version(company, textHolding(company.depot, "keep"), everyone);
      const companyReads = await outReadsOf(
        readers.reader,
        readers.readerReads,
        company,
        2
      );
      const marked = (name: string) => world.markers[name] ?? "";
      // Where a fact of a person reached along a current relation shows:
      // what recall finds by walking from the customer it names.
      const walkSurfaces = memorySurfaces.filter(
        (name) =>
          name.startsWith("recall") || name === "the Brain page's search"
      );
      // Where a current memory shows when it contests another, besides.
      const contestedToo = [
        ...memorySurfaces.slice(0, -1),
        "contested",
        ...memorySurfaces.slice(-1),
      ];

      expect({
        contestedBefore: ["out", "rival"].map((name) =>
          currentIn({ contested: before.contested }, marked(name))
        ),
        company: ["out", "keep"].map((name) =>
          currentIn(companyReads, company.markers[name] ?? "")
        ),
        once,
        again,
      }).toStrictEqual({
        contestedBefore: [["contested"], ["contested"]],
        company: [[], companyMemorySurfaces],
        once: {
          ...outcomeOnceOut,
          reader: {
            ...outcomeOnceOut.reader,
            current: {
              out: [],
              keep: memorySurfaces,
              rival: memorySurfaces,
              "out contact": [],
              "keep contact": memorySurfaces,
              "reached by out contact": [],
              "reached by keep contact": walkSurfaces,
            },
          },
          both: {
            ...outcomeOnceOut.both,
            rival: memorySurfaces,
            "out contact": [],
            "keep contact": memorySurfaces,
            "reached by out contact": [],
            "reached by keep contact": walkSurfaces,
          },
        },
        again: {
          reader: {
            current: {
              out: contestedToo,
              keep: memorySurfaces,
              rival: contestedToo,
              "out contact": [],
              "keep contact": memorySurfaces,
              "reached by out contact": [],
              "reached by keep contact": walkSurfaces,
            },
            hidden: [],
            unlikeTwin: [],
          },
          both: {
            out: contestedToo,
            keep: memorySurfaces,
            "hidden out": memorySurfaces,
            "hidden keep": memorySurfaces,
            rival: contestedToo,
            "out contact": [],
            "keep contact": memorySurfaces,
            "reached by out contact": [],
            "reached by keep contact": walkSurfaces,
          },
          // Current again, and so where every current memory shows.
          history: contestedToo,
          // Said again, the out memory contests its rival once more.
          contestedInRecall: [
            { attribute: "status", memories: ["out", "rival"] },
          ],
        },
      });
    });

    it("gives a reader nothing of a source whose current version they may not read, alike whether that version drops a quote, and its readers the memory out", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      const hiddenReaders: SourceReaders = {
        kind: "team",
        teamId: readers.hiddenTeam,
      };
      await plantFirst(readers, [
        { world, hidden: false },
        { world: twin, hidden: false },
      ]);
      // The current version, for a team the reader isn't in: the world's
      // drops the out quote, the twin's says it still.
      await version(world, textHolding(world.depot, "keep"), hiddenReaders);
      await version(
        twin,
        textHolding(twin.depot, "out", "keep"),
        hiddenReaders
      );
      const readerReads = async (each: OutWorld) =>
        await outReadsOf(readers.reader, readers.readerReads, each, 2);
      const bothReads = async (each: OutWorld) =>
        await outReadsOf(readers.both, readers.bothReads, each, 2);
      const [ours, theirs] = [
        await readerReads(world),
        await readerReads(twin),
      ];
      const [bothOurs, bothTheirs] = [
        await bothReads(world),
        await bothReads(twin),
      ];
      // Said again for the reader's team: theirs again, and current.
      await version(
        world,
        textHolding(world.depot, "out", "keep"),
        readers.teamReaders
      );
      const said = await readerReads(world);

      expect({
        nothing: ["out", "keep"].flatMap((name) =>
          shownIn(ours, world.markers[name] ?? "")
        ),
        unlikeTwin: await unlikeTwin(world, ours, twin, theirs),
        both: {
          world: currentIn(bothOurs, world.markers.out ?? ""),
          twin: currentIn(bothTheirs, twin.markers.out ?? ""),
          keep: currentIn(bothOurs, world.markers.keep ?? ""),
        },
        said: currentIn(said, world.markers.out ?? ""),
      }).toStrictEqual({
        nothing: [],
        unlikeTwin: [],
        both: { world: [], twin: memorySurfaces, keep: memorySurfaces },
        said: memorySurfaces,
      });
    });

    it("gives a person no memory of their own store current once their source's current version drops its quote, and nobody else any of it", async () => {
      const [{ userId: holder }, { userId: other }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const world = newWorld("own", newSource(), outNames, holder);
      const theirs: SourceReaders = { kind: "owner", personId: holder };
      await version(world, textHolding(world.depot, "out", "keep"), theirs);
      await remember(world, "", 1, { out: "out" });
      await remember(world, "", 1, { keep: "keep" });
      await version(world, textHolding(world.depot, "keep"), theirs);
      const marked = (name: string) => world.markers[name] ?? "";
      const own = await outReadsOf(
        holder,
        { person: holder, groups: [] },
        world,
        2
      );
      const others = await outReadsOf(
        other,
        { person: other, groups: [] },
        world,
        2
      );

      expect({
        out: currentIn(own, marked("out")),
        keep: currentIn(own, marked("keep")),
        history: shownIn(own, marked("out")),
        others: ["out", "keep"].flatMap((name) =>
          shownIn(others, marked(name))
        ),
      }).toStrictEqual({
        out: [],
        keep: ownMemorySurfaces,
        history: historySurfaces,
        others: [],
      });
    });

    it("sends the model no memory out of use in what a person's chat recalls before a question, and the memory its version still says", async () => {
      // What the turn sends the model, through a Teams direct message:
      // not the chat's stored copy of it, which keeps what a turn handed
      // over while it was current, as it keeps what was narrowed since.
      await chatAgentReadsBrain();
      const ann = await teamsMember(idp, says("Noted."));
      const team = await newTeam(ann.userId);
      const world = newWorld("shared", newSource(), outNames);
      const teamReaders: SourceReaders = { kind: "team", teamId: team };
      await version(
        world,
        textHolding(world.depot, "out", "keep"),
        teamReaders
      );
      await remember(world, `team:${team}`, 1, { out: "out" });
      await remember(world, `team:${team}`, 1, { keep: "keep" });
      await version(world, textHolding(world.depot, "keep"), teamReaders);
      const before = ann.provider.requests.length;
      await post(
        messageFrom(ann.teams, { text: `What about depot ${world.depot}?` })
      );
      const sent = JSON.stringify(
        ann.provider.requests.slice(before).map(({ body }) => body)
      );

      expect({
        answered: ann.provider.requests.length > before,
        out: sent.includes(world.markers.out ?? ""),
        keep: sent.includes(world.markers.keep ?? ""),
      }).toStrictEqual({ answered: true, out: false, keep: true });
    });

    it("judges a late memory on an earlier version as it is added, for every reader alike, and confirms it as a memory nobody holds", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      await lateWorlds(readers, world, twin);
      const outcome = await outcomeOf(readers, world, twin, 2);
      // Last: a correction adds a memory of the reader's own.
      const writes = await writesOf(readers.reader, world, ["out", "keep"]);

      expect({
        outcome,
        out: writes.out,
        keep: writes.keep,
      }).toStrictEqual({
        outcome: outcomeOnceOut,
        // Confirmed as nobody's memory. A correction takes any memory the
        // reader may read, an ended one included (`correctAs`), so it
        // answers for the out one as for a current one: it tells them
        // nothing a read doesn't.
        out: {
          confirm: writes["nobody's"]?.confirm,
          correct: "corrected",
        },
        keep: { confirm: "done", correct: "corrected" },
      });
    });

    it("orders memories learned together alike, whatever a hidden memory of their source adds", async () => {
      const readers = await outReaders();
      const world = newWorld("shared", newSource(), outNames);
      await version(
        world,
        textHolding(world.depot, "out", "keep"),
        readers.teamReaders
      );
      // Learned in one add, as an extraction's are: one learning time, so
      // what orders them after it decides, and ties break by their own ids,
      // which a twin can't match. So the same world, before and after.
      await remember(world, `team:${readers.team}`, 1, {
        out: "out",
        keep: "keep",
      });
      const readAll = async () =>
        await outReadsOf(readers.reader, readers.readerReads, world, 1);
      const before = await readAll();
      await remember(world, `team:${readers.hiddenTeam}`, 1, {
        "hidden out": "out",
      });
      const after = await readAll();

      expect(
        Object.keys(before).filter(
          (surface) => textOf(before[surface]) !== textOf(after[surface])
        )
      ).toStrictEqual([]);
    });

    it("gives no reader a memory current once the catch-up judges what an older release's version and late memory left, an unfinished pass's included, and every reader alike before", async () => {
      const readers = await outReaders();
      const group = `team:${readers.team}`;
      const hiddenGroup = `team:${readers.hiddenTeam}`;
      const [versionWorld, versionTwin] = worldAndTwin();
      const [lateWorld, lateTwin] = worldAndTwin();
      const [passWorld, passTwin] = worldAndTwin();
      // An older release's version: the second, on the twins.
      await outWorldOf(readers, [
        { world: versionWorld, hidden: true },
        { world: versionTwin, hidden: false },
      ]);
      for (const each of [versionWorld, versionTwin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await asIfOlderVersion(each, 1);
      }
      // An older release's late memories on the first version.
      await lateWorlds(readers, lateWorld, lateTwin);
      for (const each of [lateWorld, lateTwin]) {
        for (const name of Object.keys(each.memories)) {
          // oxlint-disable-next-line no-await-in-loop -- one memory at a time
          await asIfOlderLate(each, name);
        }
      }
      // A pass under way past the second version's first memory, then an
      // older release's late memory on the first: behind the pass's place.
      const pass = [passWorld, passTwin];
      const eachOf = async (write: (world: OutWorld) => Promise<void>) => {
        for (const world of pass) {
          // oxlint-disable-next-line no-await-in-loop -- a step at a time
          await write(world);
        }
      };
      await eachOf(async (each) => {
        await version(
          each,
          textHolding(each.depot, "out", "keep"),
          readers.teamReaders
        );
      });
      await eachOf(async (each) => {
        await remember(each, group, 1, { keep: "keep" });
      });
      await eachOf(async (each) => {
        await version(
          each,
          `${textHolding(each.depot, "out", "keep")} Revised.`,
          readers.teamReaders
        );
      });
      await eachOf(async (each) => {
        await remember(each, group, 2, { "keep on the second": "keep" });
      });
      await eachOf(async (each) => {
        await remember(each, group, 2, { "keep after": "keep" });
      });
      await eachOf(async (each) => {
        await version(
          each,
          textHolding(each.depot, "keep"),
          readers.teamReaders
        );
        await midPass(each, "keep on the second", 2);
      });
      await eachOf(async (each) => {
        await remember(each, group, 1, { out: "out" });
        await asIfOlderLate(each, "out");
      });
      await remember(passWorld, hiddenGroup, 1, { "hidden out": "out" });
      await remember(passWorld, hiddenGroup, 1, { "hidden keep": "keep" });
      await asIfOlderLate(passWorld, "hidden out");
      await asIfOlderLate(passWorld, "hidden keep");
      const cases = {
        "an older release's version": [versionWorld, versionTwin, 2],
        "an older release's late memory": [lateWorld, lateTwin, 2],
        "a late memory behind an unfinished pass": [passWorld, passTwin, 3],
      } as const;
      const outcomes = async () => {
        const read: Record<string, Awaited<ReturnType<typeof outcomeOf>>> = {};
        for (const [name, [world, twin, versions]] of Object.entries(cases)) {
          // oxlint-disable-next-line no-await-in-loop -- one case at a time
          read[name] = await outcomeOf(readers, world, twin, versions);
        }
        return read;
      };
      const before = await outcomes();
      const ticks = await caughtUp(
        ...Object.values(cases).flatMap(([w, t]) => [w, t])
      );
      const after = await outcomes();

      expect({
        // Until its source is judged, a memory out reads current for
        // every reader alike: the twin rule holds, nothing more.
        before: Object.fromEntries(
          Object.entries(before).map(([name, outcome]) => [
            name,
            outcome.reader.unlikeTwin,
          ])
        ),
        caughtUp: ticks > 0,
        after,
      }).toStrictEqual({
        before: Object.fromEntries(
          Object.keys(cases).map((name) => [name, []])
        ),
        caughtUp: true,
        after: Object.fromEntries(
          Object.keys(cases).map((name) => [name, outcomeOnceOut])
        ),
      });
    });

    it("judges again after new word rules, a judged source and one part-way through a pass both, and after `memories` is made anew, for every reader alike", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      const [passWorld, passTwin] = worldAndTwin();
      for (const [one, other] of [
        [world, twin],
        [passWorld, passTwin],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one pair at a time
        await outWorldOf(readers, [
          { world: one, hidden: true },
          { world: other, hidden: false },
        ]);
      }
      for (const each of [passWorld, passTwin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await midPass(each, "keep", 1);
      }
      // The judged pair's judging held, so what the new rules leave of it
      // shows before the catch-up judges it again.
      const hold = "leaks_test_holds_the_judged";
      await inStoreOf("brain", (sql) => {
        sql.exec(
          `CREATE TRIGGER ${hold} BEFORE UPDATE OF judged_row ON current_versions
          WHEN NEW.source IN ('${world.key}', '${twin.key}') AND NEW.judged_row IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
        );
      });
      onTestFinished(async () => {
        await inStoreOf("brain", (sql) => {
          sql.exec(`DROP TRIGGER IF EXISTS ${hold}`);
        });
      });
      // A release with new word rules: the rebuild starts on the next tick.
      // The pass pair's outcome doesn't depend on its place being cleared
      // (its pass ends the same from where it was); brain-next's own test
      // holds that new rules start an unfinished pass over.
      await inStoreOf("brain", (sql) => {
        sql.exec(
          "UPDATE word_index SET version = 0, target = 0, cursor = 0, memory_cursor = 0 WHERE id = 1"
        );
      });
      let words = "rebuilding";
      for (let ticks = 0; ticks < 30 && words !== "current"; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick();
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        ({ words } = await sharedStore().workOverview());
      }
      // The rules are set again only once a rebuild is done (words.ts).
      const rebuilt = (await wordRulesOf()) > 0;
      // Judged by the rules before: no judgment counts, for anyone alike.
      const between = await outcomeOf(readers, world, twin, 2);
      await inStoreOf("brain", (sql) => {
        sql.exec(`DROP TRIGGER ${hold}`);
      });
      await caughtUp(world, twin, passWorld, passTwin);
      const rules = {
        judged: await outcomeOf(readers, world, twin, 2),
        pass: await outcomeOf(readers, passWorld, passTwin, 2),
      };
      // A migration that makes `memories` anew: the cascade takes every in
      // and out row, and the migration clears every `judged_row`.
      await inStoreOf("brain", (sql) => {
        sql.exec("DELETE FROM memory_ins");
        sql.exec("DELETE FROM memory_outs");
        sql.exec("DELETE FROM memory_judging_places");
        sql.exec("UPDATE current_versions SET judged_row = NULL");
      });
      await caughtUp(world, twin);
      const anew = await outcomeOf(readers, world, twin, 2);

      expect({
        words,
        rebuilt,
        between: {
          out: between.reader.current.out,
          unlikeTwin: between.reader.unlikeTwin,
        },
        rules,
        anew,
      }).toStrictEqual({
        words: "current",
        rebuilt: true,
        between: { out: memorySurfaces, unlikeTwin: [] },
        rules: { judged: outcomeOnceOut, pass: outcomeOnceOut },
        anew: outcomeOnceOut,
      });
    });

    it("forgets the source the catch-up's turn and a pass hold once it is erased, or its upload removed, and judges the rest", async () => {
      const readers = await outReaders();
      const uploader = await signedInApi(idp, "user");
      await join(readers.team, uploader.userId);
      const [turnHeld, passHeld] = [
        newWorld("shared", newSource(), outNames),
        newWorld("shared", newSource(), outNames),
      ];
      const [rest, restTwin] = worldAndTwin();
      for (const each of [turnHeld, passHeld]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await outWorldOf(readers, [{ world: each, hidden: false }]);
      }
      await outWorldOf(readers, [
        { world: rest, hidden: true },
        { world: restTwin, hidden: false },
      ]);
      // An upload of the team's, with memories on its first version.
      const uploadDepot = outWord("d");
      const { source: uploaded } = await uploader.api.brainSources.upload(
        transcriptOf(textHolding(uploadDepot, "out", "keep")),
        readers.teamReaders,
        crypto.randomUUID()
      );
      const upload = {
        ...newWorld("shared", uploaded, outNames),
        depot: uploadDepot,
      };
      await remember(upload, `team:${readers.team}`, 1, { out: "out" });
      await remember(upload, `team:${readers.team}`, 1, { keep: "keep" });
      await uploader.api.brainSources.uploadVersion(
        uploaded.id,
        transcriptOf(textHolding(uploadDepot, "keep")),
        crypto.randomUUID()
      );
      for (const each of [turnHeld, passHeld, upload, rest, restTwin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await midPass(each, "out", 1);
      }
      await inStoreOf("brain", (sql) => {
        sql.exec(
          `INSERT INTO memory_judging (id, through, turn) VALUES (1, 0, ?1)
          ON CONFLICT (id) DO UPDATE SET turn = ?1`,
          turnHeld.key
        );
      });
      await eraseSource(env, {
        source: turnHeld.source,
        readers: readers.teamReaders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: passHeld.source,
        readers: readers.teamReaders,
        reason: "deleted",
      });
      await uploader.api.brainSources.deleteUpload(uploaded.id);
      const turn = await inStoreOf(
        "brain",
        (sql) =>
          sql
            .exec<{ turn: string | null }>(
              "SELECT turn FROM memory_judging WHERE id = 1"
            )
            .one().turn
      );
      const held = {
        turn: await tablesHolding(turnHeld.key),
        pass: await tablesHolding(passHeld.key),
      };
      await caughtUp(rest, restTwin);
      const gone = async (world: OutWorld) => {
        const reads = await outReadsOf(
          readers.reader,
          readers.readerReads,
          world,
          2
        );
        return ["out", "keep"].flatMap((name) =>
          shownIn(reads, world.markers[name] ?? "")
        );
      };

      expect({
        turn,
        held,
        gone: {
          turn: await gone(turnHeld),
          pass: await gone(passHeld),
          upload: await gone(upload),
        },
        rest: await outcomeOf(readers, rest, restTwin, 2),
      }).toStrictEqual({
        turn: null,
        held: { turn: [], pass: [] },
        gone: { turn: [], pass: [], upload: [] },
        rest: outcomeOnceOut,
      });
    });

    it("never puts out a memory of a thread or of a source kept whole, whatever its later versions say", async () => {
      const readers = await outReaders();
      const group = `team:${readers.team}`;
      const thread = newWorld("shared", newSource(), outNames);
      for (const [step, held] of [
        [1, ["out", "keep"]],
        [10, ["keep"]],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        await sharedStore().addSource({
          source: thread.key,
          change: crypto.randomUUID(),
          text: textHolding(thread.depot, ...held),
          access: { kind: "audience", group },
          thread: true,
        });
        if (step === 1) {
          // oxlint-disable-next-line no-await-in-loop -- once, on the first
          await remember(thread, group, 1, { out: "out" });
          // oxlint-disable-next-line no-await-in-loop -- once, on the first
          await remember(thread, group, 1, { keep: "keep" });
        }
      }
      const threadReads = await outReadsOf(
        readers.reader,
        readers.readerReads,
        thread,
        2
      );
      // A person's instruction file: kept whole, in their own store.
      const whole = newWorld(
        "own",
        { producer: "upload", id: crypto.randomUUID() },
        outNames,
        readers.reader
      );
      whole.key = `instructions:person:${readers.reader}`;
      const file: InstructionFile = {
        scope: "person",
        personId: readers.reader,
      };
      await addInstructionFile(env, {
        file,
        change: crypto.randomUUID(),
        text: textHolding(whole.depot, "out", "keep"),
        after: 0,
      });
      await remember(whole, "", 1, { out: "out" });
      await remember(whole, "", 1, { keep: "keep" });
      await addInstructionFile(env, {
        file,
        change: crypto.randomUUID(),
        text: textHolding(whole.depot, "keep"),
        after: 1,
      });
      // Core names no source of a memory that rests on an instruction
      // file (core never draws one), so it is read where it is kept.
      const wholeReader = { person: readers.reader, groups: [] };
      const wholeReads = {
        "the store's card": await ownStoreOf(readers.reader).readCard({
          entity: whole.entity,
          reader: wholeReader,
        }),
        "the store's memories": await ownStoreOf(readers.reader).readMemories({
          entity: whole.entity,
          reader: wholeReader,
        }),
      };
      expect({
        thread: currentIn(threadReads, thread.markers.out ?? ""),
        whole: currentIn(wholeReads, whole.markers.out ?? ""),
        wholeKeep: currentIn(wholeReads, whole.markers.keep ?? ""),
      }).toStrictEqual({
        thread: memorySurfaces,
        whole: ["the store's card", "the store's memories"],
        wholeKeep: ["the store's card", "the store's memories"],
      });
    });

    it("gives every reader alike a restored memory out before and during the catch-up, tick by tick, and none of them it current once it is done", async () => {
      await answeringProvider(() => {});
      const admin = await signedInWithRole(idp, "admin");
      const readers = await outReaders();
      // Five sources in the catch-up's key order: two world and twin pairs
      // around a gate, whose judging the test holds, so the catch-up stops
      // at it on each tick until the hold is lifted.
      const [first, firstTwin, gate, last, lastTwin] = Array.from(
        { length: 5 },
        () => crypto.randomUUID()
      )
        .toSorted()
        .map((id) => newWorld("shared", { producer: "upload", id }, outNames));
      if (
        first === undefined ||
        firstTwin === undefined ||
        gate === undefined ||
        last === undefined ||
        lastTwin === undefined
      ) {
        throw new Error("Five worlds");
      }
      for (const worlds of [
        [
          { world: first, hidden: true },
          { world: firstTwin, hidden: false },
        ],
        [{ world: gate, hidden: false }],
        [
          { world: last, hidden: true },
          { world: lastTwin, hidden: false },
        ],
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one clock at a time
        await outWorldOf(readers, worlds);
      }
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
      // The shared store's storage lost, its bucket kept, and the export
      // restored: no source judged, no in or out row.
      await restoreStore(emptyStore);
      await adminRequest(admin.session, brainRestorePath, { exportId: id });
      const restored = await tickedPast(
        admin.session,
        `${brainRestorePath}?id=${id}`,
        "running"
      );
      const hold = "leaks_test_holds_the_gate";
      await inStoreOf("brain", (sql) => {
        sql.exec(
          `CREATE TRIGGER ${hold} BEFORE UPDATE OF judged_row ON current_versions
          WHEN NEW.source = '${gate.key}' AND NEW.judged_row IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
        );
      });
      // Gone whatever ends the test: a hold left would stop the shared
      // store's catch-up for every test after.
      onTestFinished(async () => {
        await inStoreOf("brain", (sql) => {
          sql.exec(`DROP TRIGGER IF EXISTS ${hold}`);
        });
      });
      const pairs = {
        first: [first, firstTwin],
        last: [last, lastTwin],
      } as const;
      /** Each pair's twin differences and whether each of its worlds is judged, as the reader reads now. */
      const state = async () => {
        const read: Record<string, unknown> = {};
        for (const [name, [world, twin]] of Object.entries(pairs)) {
          // oxlint-disable-next-line no-await-in-loop -- one pair at a time
          const outcome = await outcomeOf(readers, world, twin, 2);
          read[name] = {
            // oxlint-disable-next-line no-await-in-loop -- one pair at a time
            judged: await judged(world, twin),
            unlikeTwin: outcome.reader.unlikeTwin,
            out: outcome.reader.current.out,
          };
        }
        return read;
      };
      const before = await state();
      await tick();
      const firstTick = await state();
      await tick();
      const secondTick = await state();
      await inStoreOf("brain", (sql) => {
        sql.exec(`DROP TRIGGER ${hold}`);
      });
      await tick();
      const after = {
        first: await outcomeOf(readers, first, firstTwin, 2),
        last: await outcomeOf(readers, last, lastTwin, 2),
        gate: await judged(gate),
      };
      const pending = {
        judged: [false, false],
        unlikeTwin: [],
        out: memorySurfaces,
      };
      const done = { judged: [true, true], unlikeTwin: [], out: [] };

      expect({
        exported,
        restored,
        before,
        firstTick,
        secondTick,
        after,
      }).toStrictEqual({
        exported: "done",
        restored: "done",
        // Restored, nothing judged: every reader reads the out memories
        // current alike (the stated time, GRA-1915).
        before: { first: pending, last: pending },
        // The keys before the gate judged; the gate held.
        firstTick: { first: done, last: pending },
        // The keys after it, then the gate again.
        secondTick: { first: done, last: done },
        after: {
          first: outcomeOnceOut,
          last: outcomeOnceOut,
          gate: [true],
        },
      });
    });
  }
);

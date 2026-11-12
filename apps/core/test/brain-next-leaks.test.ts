import {
  exactCandidatesMax,
  recallBudgetMax,
} from "@grasp-os/brain-next/contract";
import { authoritySchema } from "@grasp-os/shared/permissions";
import { DurableObject, env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { appFor } from "../src/apps.ts";
import { organizationId } from "../src/auth/auth.ts";
import { memberOf } from "../src/auth/identity.ts";
import {
  addInstructionFile,
  addSource,
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
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { BrainStore } from "../src/index.ts";
import { instructionFilesFor } from "../src/instruction-files.ts";
import { published } from "./apps.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import {
  coreProbes,
  instructionProbes,
  storeProbes,
  textOf,
} from "./brain-next-surfaces.ts";
import type { Answer, Probe, Probing } from "./brain-next-surfaces.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { carrying } from "./platform-providers.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

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

/** Every surface, by name, with its probe. */
const surfaces: [string, Probe][] = [
  ...Object.entries(coreProbes).map(([name, probe]): [string, Probe] => [
    `core ${name}`,
    probe,
  ]),
  ...Object.entries(instructionProbes).map(([name, probe]): [string, Probe] => [
    `instructions ${name}`,
    probe,
  ]),
  ...Object.entries(storeProbes).map(([name, probe]): [string, Probe] => [
    `store ${name}`,
    probe,
  ]),
];

/**
 * What a surface's answers give away: a forbidden marker, a hidden-only
 * answer unlike its answer to words nothing holds, or no answer worth the
 * name (a probe that calls nothing, or only ever gets errors, covers
 * nothing).
 */
const findingsIn = (
  answers: readonly Answer[],
  forbidden: Readonly<Record<string, string>>
): string[] => {
  // Each hidden answer against the nothing answer of its comparison.
  const nothingOf = (like: string | undefined) =>
    answers.find((one) => one.about === "nothing" && one.like === like);
  const unlike = answers.flatMap(({ about, got, call, like }) => {
    const nothing = nothingOf(like);
    return about === "hidden" && textOf(got) !== textOf(nothing?.got)
      ? [
          `"${call}" answered ${textOf(got)}, unlike "${nothing?.call}": ${textOf(nothing?.got)}`,
        ]
      : [];
  });
  const thin = answers.some(({ got }) => "value" in got)
    ? []
    : ["no call answered"];
  return [...markersIn(answers, forbidden), ...unlike, ...thin];
};

/** The surfaces that recall, where no instruction file may ever show. */
const recallSurfaces = new Set(["core recallAs", "store recall"]);

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
  }: {
    among?: readonly [string, Probe][];
    inRecall?: Readonly<Record<string, string>>;
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
        recallSurfaces.has(name) ? { ...forbidden, ...inRecall } : forbidden
      ).map((found) => ({ pass, in: name, found }))
    ),
    ...markersIn(lines, forbidden).map((found) => ({
      pass,
      in: "logs",
      found,
    })),
  ];
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
    question,
    budget: { tokens: recallBudgetMax },
  });
  return items.map(({ text }) => text);
};

/**
 * Each public method of the store: its own and any it inherits, up to the
 * Durable Object base class.
 */
const storeMethods = (): string[] => {
  const names = new Set<string>();
  for (
    let prototype: unknown = BrainStore.prototype;
    prototype !== DurableObject.prototype &&
    prototype !== Object.prototype &&
    typeof prototype === "object" &&
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      names.add(name);
    }
  }
  names.delete("constructor");
  return [...names];
};

describe(
  "the new Brain leaks nothing to a reader without access",
  { timeout: 120_000 },
  () => {
    it("has a probe for every member core and the Brain's store expose", async () => {
      const coreMembers = Object.keys(await import("../src/brain-next.ts"));
      const instructionMembers = Object.keys(
        await import("../src/instruction-files.ts")
      );

      expect({
        core: coreMembers.toSorted(),
        instructions: instructionMembers.toSorted(),
        store: storeMethods().toSorted(),
      }).toStrictEqual({
        core: Object.keys(coreProbes).toSorted(),
        instructions: Object.keys(instructionProbes).toSorted(),
        store: Object.keys(storeProbes).toSorted(),
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
        "the holder's instruction file": markerWord(),
        "another agent's instruction file": markerWord(),
        "an App's instruction file the outsider doesn't build": markerWord(),
        "an App's instruction file the outsider uses": markerWord(),
      };
      const {
        "the holder's own source": ownerMarker,
        "a team's source the outsider isn't in": teamMarker,
        "a source nobody is known to read": noneMarker,
        "a source narrowed away from the outsider": narrowedMarker,
        "the holder's instruction file": holderFileMarker,
        "another agent's instruction file": agentFileMarker,
        "an App's instruction file the outsider doesn't build": appFileMarker,
        "an App's instruction file the outsider uses": usedAppFileMarker,
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
      const capId = `CAP-${unique()}`;
      // And two days: one the outsider's own chunk writes too, one only
      // these copies write.
      for (let index = 0; index <= exactCandidatesMax; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await add(
          `Copy ${index} ${ownerMarker} ${capId} 17 juni 2031 4 mei 2032`,
          {
            kind: "owner",
            personId: holder,
          }
        );
      }
      const capped = `The outsider's own, much longer than any copy: ${capId}, due on 17 June 2031.`;
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
      // then narrowed to the holder. Its first version is neither the
      // outsider's now (taken off) nor ever the holder's (not among its
      // readers), though the holder reads the current one.
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
      await add(
        `Final plan ${sharedWord}`,
        { kind: "owner", personId: holder },
        narrowedId
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
        question: capId,
        budget: { tokens: recallBudgetMax },
      });
      const cappedFinds = cappedItems.map(({ text, found }) => ({
        text,
        found,
      }));
      // By the day both write, their own chunk as exact; by the day only
      // the hidden copies write, the pack of a day nothing writes.
      const recalled = async (question: string) =>
        await recallAs(env, outsider, {
          question,
          budget: { tokens: recallBudgetMax },
        });
      const { items: datedItems } = await recalled("2031-06-17");
      const datedFinds = datedItems.map(({ text, found }) => ({ text, found }));
      const hiddenDay = JSON.stringify(await recalled("2032-05-04")).replaceAll(
        "2032-05-04",
        "2032-05-05"
      );
      const noDay = JSON.stringify(await recalled("2032-05-05"));

      const asOutsider = (groups: string[]): Probing => ({
        personId: outsider,
        reader: { person: outsider, groups: groups.map((id) => `team:${id}`) },
        sharedWord,
        markers: [
          ownerMarker,
          teamMarker,
          noneMarker,
          narrowedMarker,
          ...instructionMarkers,
        ],
        hiddenVersions: everyVersionOf(...ownerIds, teamId, noneId, narrowedId),
        hiddenInstructionFiles: [holderFile, agentFile, appFile, usedAppFile],
        usedApps,
        instructionGroups,
        moments: [whileDraft],
      });
      const first = await findingsOf(
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
      const inTheTeam = await findingsOf(
        "the outsider, in the team",
        {
          ...asOutsider([ownTeam, secretTeam]),
          markers: [
            ownerMarker,
            noneMarker,
            narrowedMarker,
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
      const outAgain = await findingsOf(
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
          reader: { person: holder, groups: [`team:${secretTeam}`] },
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
          ...prompted,
        ],
        outsiderFinds,
        cappedFinds,
        datedFinds,
        hiddenDay,
        joinedFinds,
        leftFinds,
        holderAppFile: holderAppFiles.some(({ text }) => text === usedAppText),
        outsiderOpens,
      }).toStrictEqual({
        findings: [],
        outsiderFinds: [handbook],
        cappedFinds: [{ text: capped, found: "exact" }],
        datedFinds: [{ text: capped, found: "exact" }],
        hiddenDay: noDay,
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
      await eraseSource(env, { source: chat, reason: "deleted" });
      await eraseSource(env, { source: upload, reason: "deleted" });
      await eraseSource(env, { source: run, reason: "retention" });
      await eraseSource(env, { source: teamSource, reason: "deleted" });
      await erasePerson(env, { personId: holder, reason: "person_erased" });
      await workBrain(env, new Date());
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
        sharedWord,
        markers: Object.values(markers),
        hiddenVersions: erased,
        hiddenInstructionFiles,
        instructionGroups: ["company"],
      });
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
            among: surfaces.filter(
              ([name]) => name !== "instructions saveInstructionFile"
            ),
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
  }
);

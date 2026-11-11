import { DurableObject, env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { BrainStore } from "../src/index.ts";
import { coreProbes, storeProbes, textOf } from "./brain-next-surfaces.ts";
import type { Answer, Probe, Probing } from "./brain-next-surfaces.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { carrying } from "./platform-providers.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// The marker test (GRA-1722): the gate every later Brain issue keeps
// green. Unique marker words are planted in sources a reader may not
// read: someone else's own, a team's they aren't in, and one nobody is
// known to read. Then every surface (brain-next-surfaces.ts) is called as
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
  const nothing = answers.find(({ about }) => about === "nothing");
  const unlike = answers
    .filter(
      ({ about, got }) =>
        about === "hidden" && textOf(got) !== textOf(nothing?.got)
    )
    .map(
      ({ call, got }) =>
        `"${call}" answered ${textOf(got)}, unlike "${nothing?.call}": ${textOf(nothing?.got)}`
    );
  const thin = answers.some(({ got }) => "value" in got)
    ? []
    : ["no call answered"];
  return [...markersIn(answers, forbidden), ...unlike, ...thin];
};

/**
 * Calls every surface as `probing`'s reader; what they gave away, in
 * their answers or in the console.
 */
const findingsOf = async (
  pass: string,
  probing: Probing,
  forbidden: Readonly<Record<string, string>>
): Promise<Finding[]> => {
  const { value: answered, lines } = await logsOf(async () => {
    const found: [string, Answer[]][] = [];
    for (const [name, probe] of surfaces) {
      // oxlint-disable-next-line no-await-in-loop -- one surface at a time
      found.push([name, await probe(probing)]);
    }
    return found;
  });
  return [
    ...answered.flatMap(([name, answers]) =>
      findingsIn(answers, forbidden).map((found) => ({ pass, in: name, found }))
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

const add = async (text: string, readers: SourceReaders): Promise<string> => {
  const { id } = await addSource(env, { text, readers });
  return id;
};

/** What `personId` recalls for `question`: each source's text. */
const textsFor = async (
  personId: string,
  question: string
): Promise<string[]> => {
  const { sources } = await recallAs(env, personId, question);
  return sources.map(({ text }) => text);
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

      expect({
        core: coreMembers.toSorted(),
        store: storeMethods().toSorted(),
      }).toStrictEqual({
        core: Object.keys(coreProbes).toSorted(),
        store: Object.keys(storeProbes).toSorted(),
      });
    });

    it("gives away no marker or hidden match in any answer, log line or prompt, across membership changes and to a reader of everything else", async () => {
      // A provider is connected, so anything that prompts a model reaches
      // the providers stub, which keeps every request it gets.
      await answeringProvider(() => {});
      const [holder, outsider] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]).then((people) => people.map(({ userId }) => userId));
      if (holder === undefined || outsider === undefined) {
        throw new Error("Expected two people");
      }
      const secretTeam = await newTeam(holder);
      const ownTeam = await newTeam(outsider);
      const sharedWord = `s${unique()}`;
      const unknownWord = `u${unique()}`;
      const markers = {
        "the holder's own source": markerWord(),
        "a team's source the outsider isn't in": markerWord(),
        "a source nobody is known to read": markerWord(),
      };
      const {
        "the holder's own source": ownerMarker,
        "a team's source the outsider isn't in": teamMarker,
        "a source nobody is known to read": noneMarker,
      } = markers;
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
      const handbook = `The handbook for everyone who joins the team, ${sharedWord}`;
      await add(handbook, { kind: "team", teamId: ownTeam });

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

      const asOutsider = (groups: string[]): Probing => ({
        personId: outsider,
        reader: { person: outsider, groups: groups.map((id) => `team:${id}`) },
        sharedWord,
        unknownWord,
        markers: [ownerMarker, teamMarker, noneMarker],
        hiddenIds: [...ownerIds, teamId, noneId],
      });
      const first = await findingsOf(
        "the outsider",
        asOutsider([ownTeam]),
        markers
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
          markers: [ownerMarker, noneMarker],
          hiddenIds: [...ownerIds, noneId],
        },
        notJoined
      );

      // Leaving counts from the very next recall too.
      await leave(secretTeam, outsider);
      const leftFinds = await textsFor(outsider, teamMarker);
      const outAgain = await findingsOf(
        "the outsider, out of the team again",
        asOutsider([ownTeam]),
        markers
      );

      // Someone who may read everything else still never gets the source
      // nobody is known to read.
      const asHolder = await findingsOf(
        "the holder",
        {
          personId: holder,
          reader: { person: holder, groups: [`team:${secretTeam}`] },
          sharedWord,
          unknownWord,
          markers: [noneMarker],
          hiddenIds: [noneId],
        },
        { "a source nobody is known to read": noneMarker }
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
        joinedFinds,
        leftFinds,
      }).toStrictEqual({
        findings: [],
        outsiderFinds: [handbook],
        joinedFinds: [teamSource],
        leftFinds: [],
      });
    });
  }
);

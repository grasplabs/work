import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { BrainStore } from "../src/index.ts";
import { coreProbes, storeProbes } from "./brain-next-surfaces.ts";
import type { Probe, Probing } from "./brain-next-surfaces.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// The marker test (GRA-1722): the gate every later Brain issue keeps
// green. Unique marker words are planted in sources a reader may not
// read: someone else's own, a team's they aren't in, and one nobody is
// known to read. Then every surface (brain-next-surfaces.ts) is called as
// that reader, every way it answers, and no marker may be in anything
// that comes back (results, "nothing found", errors), in a log line
// written meanwhile, or in a prompt that reached a model (core's model
// provider stub, test/model-provider.ts, keeps every request). The same
// runs again across a change in membership and as a reader of everything
// but the source nobody may read.

const idp = mockIdp();

/** The levels of console the harness reads. */
const logLevels = ["debug", "log", "info", "warn", "error"] as const;

/** A word nothing else holds. */
const markerWord = (): string => `m${crypto.randomUUID().replaceAll("-", "")}`;

/** A marker found where it may not be. */
interface Leak {
  /** Who was reading. */
  pass: string;
  /** Which marker: the source it was planted in. */
  marker: string;
  /** Where it was found: a surface's answers, the logs, or a prompt. */
  in: string;
}

/** The markers of `forbidden` that `found` holds, by name. */
const markersIn = (
  found: unknown,
  forbidden: Readonly<Record<string, string>>
): string[] => {
  const text = (JSON.stringify(found) ?? "").toLowerCase();
  return Object.entries(forbidden)
    .filter(([, marker]) => text.includes(marker))
    .map(([name]) => name);
};

/** Every log line written while `run` runs, and what it returned. */
const logsOf = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; lines: unknown[] }> => {
  const lines: unknown[] = [];
  const spies = logLevels.map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
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
 * Calls every surface as `probing`'s reader and returns each marker of
 * `forbidden` found in what came back or in the logs.
 */
const leaksOf = async (
  pass: string,
  probing: Probing,
  forbidden: Readonly<Record<string, string>>
): Promise<Leak[]> => {
  const { value: answers, lines } = await logsOf(async () => {
    const found: [string, unknown[]][] = [];
    for (const [name, probe] of surfaces) {
      // oxlint-disable-next-line no-await-in-loop -- one surface at a time
      found.push([name, await probe(probing)]);
    }
    return found;
  });
  return [
    ...answers.flatMap(([name, answered]) =>
      markersIn(answered, forbidden).map((marker) => ({
        pass,
        marker,
        in: name,
      }))
    ),
    ...markersIn(lines, forbidden).map((marker) => ({
      pass,
      marker,
      in: "logs",
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

describe(
  "the new Brain leaks nothing to a reader without access",
  { timeout: 120_000 },
  () => {
    it("has a probe for every member core and the Brain's store expose", async () => {
      const coreMembers = Object.keys(await import("../src/brain-next.ts"));
      const storeMembers = Object.getOwnPropertyNames(
        BrainStore.prototype
      ).filter((name) => name !== "constructor");

      expect({
        core: coreMembers.toSorted(),
        store: storeMembers.toSorted(),
      }).toStrictEqual({
        core: Object.keys(coreProbes).toSorted(),
        store: Object.keys(storeProbes).toSorted(),
      });
    });

    it("shows no marker in any answer, log line or prompt, across membership changes and to a reader of everything else", async () => {
      // Everything a model is sent meanwhile reaches this stub; it answers
      // nothing, as no Brain surface needs a model yet.
      const provider = await answeringProvider(() => {});
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
      await add(`Salary review ${sharedWord} ${ownerMarker}`, {
        kind: "owner",
        personId: holder,
      });
      await add(`Board minutes ${sharedWord} ${teamMarker}`, {
        kind: "team",
        teamId: secretTeam,
      });
      await add(`Unfiled note ${sharedWord} ${noneMarker}`, { kind: "none" });
      // More marked matches than a recall returns, each shorter than the
      // outsider's own, so hidden ones would crowd it out if they took
      // places.
      for (let index = 0; index <= 10; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await add(`${sharedWord} ${ownerMarker}`, {
          kind: "owner",
          personId: holder,
        });
      }
      const handbook = `The handbook for everyone who joins the team, ${sharedWord}`;
      await add(handbook, { kind: "team", teamId: ownTeam });

      // The markers are there to find for those who may read them.
      await expect(textsFor(holder, teamMarker)).resolves.toStrictEqual([
        `Board minutes ${sharedWord} ${teamMarker}`,
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
        markers: [ownerMarker, teamMarker, noneMarker],
      });
      const asOutsiderFirst = await leaksOf(
        "the outsider",
        asOutsider([ownTeam]),
        markers
      );

      // Joining the team counts from the next recall: its source is theirs
      // to read, and nothing else is.
      await join(secretTeam, outsider);
      const joinedFinds = await textsFor(outsider, teamMarker);
      const { "a team's source the outsider isn't in": _joined, ...notJoined } =
        markers;
      const inTheTeam = await leaksOf(
        "the outsider, in the team",
        {
          ...asOutsider([ownTeam, secretTeam]),
          markers: [ownerMarker, noneMarker],
        },
        notJoined
      );

      // Leaving counts from the next recall too.
      await leave(secretTeam, outsider);
      const outAgain = await leaksOf(
        "the outsider, out of the team again",
        asOutsider([ownTeam]),
        markers
      );

      // Someone who may read everything else still never gets the source
      // nobody is known to read.
      const asHolder = await leaksOf(
        "the holder",
        {
          personId: holder,
          reader: { person: holder, groups: [`team:${secretTeam}`] },
          sharedWord,
          markers: [noneMarker],
        },
        { "a source nobody is known to read": noneMarker }
      );

      const prompted = markersIn(
        provider.requests.map(({ url, body }) => ({ url, body })),
        markers
      ).map((marker) => ({ pass: "every pass", marker, in: "model prompts" }));
      const leaks: Leak[] = [
        ...asOutsiderFirst,
        ...inTheTeam,
        ...outAgain,
        ...asHolder,
        ...prompted,
      ];
      expect({ leaks, outsiderFinds, joinedFinds }).toStrictEqual({
        leaks: [],
        outsiderFinds: [handbook],
        joinedFinds: [`Board minutes ${sharedWord} ${teamMarker}`],
      });
    });
  }
);

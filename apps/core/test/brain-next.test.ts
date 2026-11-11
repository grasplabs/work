import type { SourceId } from "@grasp-os/brain-next/contract";
import {
  questionMaxLength,
  readerGroupsMax,
  recallLimit,
  sourceTextMaxBytes,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// The new Brain's first path (GRA-1720): core adds a source with who may
// read it and recalls it by words, as a member core resolves from its own
// records, through the Brain's contract into its store. From the threat
// model on the issue: the reader is core's, never the caller's; group
// membership is core's, read at each recall; the question is words, never
// FTS5 syntax, folded as the indexed text is; access is checked inside the
// search, so hidden sources neither show, take places nor move the order;
// malformed readers are refused whole.

const idp = mockIdp();

/** A word no other test's sources hold. */
const word = () => `w${unique()}`;

/** What core or the store says when it refuses an input. */
const refused = /^(?:The Brain refused it|Unknown readers)/u;

/** A member of the organization, signed in. */
const person = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** A team of the organization, `id` when given. */
const newTeam = async (id: string = crypto.randomUUID()): Promise<string> => {
  await drizzle(env.DB)
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  return id;
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

/** Puts `userId` in `count` new teams. */
const inTeams = async (userId: string, count: number): Promise<void> => {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const now = Date.now();
  await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(id, `Team ${id}`, organizationId, now),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), id, userId, now),
    ])
  );
};

const add = async (text: string, readers: SourceReaders): Promise<SourceId> => {
  const { id } = await addSource(env, { text, readers });
  return id;
};

/** What the member `personId` recalls for `question`, by ID, best first. */
const recalledAs = async (
  personId: string,
  question: string
): Promise<SourceId[]> => {
  const { sources } = await recallAs(env, personId, question);
  return sources.map(({ id }) => id);
};

/** Adds `text` for `readers` as given, unchecked, as a caller outside TypeScript could. */
const addUnchecked = async (text: string, readers: unknown): Promise<unknown> =>
  // SAFETY: core and the store check what they are given; these tests
  // hand them what the type rules out, as a call from outside TypeScript
  // could.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  await addSource(env, { text, readers: readers as SourceReaders });

/** `text` in full-width forms (Ａ for A), as some sources hold it. */
const fullWidth = (text: string): string =>
  text.replaceAll(/[!-~]/gu, (character) =>
    String.fromCodePoint((character.codePointAt(0) ?? 0) + 0xfe_e0)
  );

describe("the new Brain, inside core", { timeout: 60_000 }, () => {
  it("finds a source added for one person by their recall and by nobody else's", async () => {
    const [owner, other, teammate] = await Promise.all([
      person(),
      person(),
      person(),
    ]);
    const team = await newTeam();
    await join(team, owner);
    await join(team, teammate);
    const secret = word();
    const id = await add(`Salary review for ${secret}`, {
      kind: "owner",
      personId: owner,
    });

    await expect(recalledAs(owner, `salary ${secret}`)).resolves.toStrictEqual([
      id,
    ]);
    await expect(recalledAs(other, `salary ${secret}`)).resolves.toStrictEqual(
      []
    );
    // Sharing a team with the owner gives nothing of what is theirs alone.
    await expect(
      recalledAs(teammate, `salary ${secret}`)
    ).resolves.toStrictEqual([]);
  });

  it("returns a source with no known readers to no one", async () => {
    const [someone, member] = await Promise.all([person(), person()]);
    const team = await newTeam();
    await join(team, member);
    const secret = word();
    await add(`Unknown readers ${secret}`, { kind: "none" });
    await add(`Unknown readers ${secret}`, { kind: "none" });

    await expect(recalledAs(someone, secret)).resolves.toStrictEqual([]);
    await expect(recalledAs(member, secret)).resolves.toStrictEqual([]);
  });

  it("follows a team's membership as core keeps it, with no call to the Brain between", async () => {
    const [newcomer, stayer] = await Promise.all([person(), person()]);
    const team = await newTeam();
    await join(team, stayer);
    const handbook = word();
    const id = await add(`The ${handbook} handbook`, {
      kind: "team",
      teamId: team,
    });

    await expect(recalledAs(stayer, handbook)).resolves.toStrictEqual([id]);
    await expect(recalledAs(newcomer, handbook)).resolves.toStrictEqual([]);

    await join(team, newcomer);
    await expect(recalledAs(newcomer, handbook)).resolves.toStrictEqual([id]);

    await leave(team, newcomer);
    await expect(recalledAs(newcomer, handbook)).resolves.toStrictEqual([]);
    await expect(recalledAs(stayer, handbook)).resolves.toStrictEqual([id]);
  });

  it("takes the reader from core's records: someone no longer a member recalls nothing", async () => {
    const removed = await person();
    const secret = word();
    await add(secret, { kind: "owner", personId: removed });
    await expect(recalledAs(removed, secret)).resolves.toHaveLength(1);

    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(removed)
      .run();
    await expect(recalledAs(removed, secret)).rejects.toMatchObject({
      code: "permission.person_inactive",
    });
  });

  it("keeps a person and a team of the same ID apart", async () => {
    const [named, member] = await Promise.all([person(), person()]);
    // A team whose ID is the person's own.
    const team = await newTeam(named);
    await join(team, member);
    const secret = word();
    const asPerson = await add(secret, { kind: "owner", personId: named });
    const asTeam = await add(secret, { kind: "team", teamId: named });

    await expect(recalledAs(named, secret)).resolves.toStrictEqual([asPerson]);
    await expect(recalledAs(member, secret)).resolves.toStrictEqual([asTeam]);
  });

  it("reads a question as words, never as search syntax", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const mine = word();
    const theirs = word();
    const id = await add(`Invoice ${mine}`, {
      kind: "owner",
      personId: reader,
    });
    const hidden = await add(`Payroll ${theirs} ${mine}x`, {
      kind: "owner",
      personId: other,
    });

    // A prefix is a word like any other: "mine*" isn't "minex".
    await expect(recalledAs(reader, `${mine}*`)).resolves.toStrictEqual([id]);
    for (const question of [
      `${mine}*`,
      `text:${theirs}`,
      `NOT ${mine} OR ${theirs}`,
      `"${theirs}" OR ${mine}x`,
      `NEAR(${mine} ${theirs})`,
      `^${theirs} * ${mine}`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      await expect(recalledAs(reader, question)).resolves.not.toContain(hidden);
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      await expect(recalledAs(other, question)).resolves.not.toContain(id);
    }
    await expect(recalledAs(reader, `*"():^-+`)).resolves.toStrictEqual([]);
  });

  it("folds a source and a question alike: case, accents, ligatures and full-width forms", async () => {
    const reader = await person();
    const owner = { kind: "owner", personId: reader } as const;
    const tag = word();
    const accented = await add(`De FINANCIËLE regeling ${tag}`, owner);
    const decomposed = await add(`Financiële ${tag}`, owner);
    const ligature = word();
    const fromPdf = await add(`ﬁ${ligature} report`, owner);
    const wide = word();
    const fullWidthSource = await add(fullWidth(wide.toUpperCase()), owner);

    // Composed or decomposed, with or without the accent.
    for (const question of [`financiele ${tag}`, `Financiële ${tag}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const found = await recalledAs(reader, question);
      expect(found.toSorted()).toStrictEqual([accented, decomposed].toSorted());
    }
    // "ﬁ" (one character, as PDFs hold it) is "fi".
    await expect(recalledAs(reader, `fi${ligature}`)).resolves.toStrictEqual([
      fromPdf,
    ]);
    // Full-width letters, by plain letters and by their own form.
    await expect(recalledAs(reader, wide)).resolves.toStrictEqual([
      fullWidthSource,
    ]);
    await expect(
      recalledAs(reader, fullWidth(wide.toUpperCase()))
    ).resolves.toStrictEqual([fullWidthSource]);
  });

  it("counts a word once however the question spells it", async () => {
    const reader = await person();
    const owner = { kind: "owner", personId: reader } as const;
    const [base, second, third] = [word(), word(), word()];
    // One word, short; and two others, in a longer text.
    const short = await add(`${base}e`, owner);
    const two = await add(`${second} ${third} and some more words`, owner);

    // `${base}é` and `${base}e` are one word: `short` holds one of the
    // question's words, `two` holds two, so `two` comes first.
    await expect(
      recalledAs(reader, `${base}é ${base}e ${second} ${third}`)
    ).resolves.toStrictEqual([two, short]);
  });

  it("ranks on a source's own words, so hidden sources neither take places nor move the order", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const [one, two, three] = [word(), word(), word()];
    const mine = { kind: "owner", personId: reader } as const;
    const all = await add(`${one} ${two} ${three}`, mine);
    const twoWords = await add(
      `${one} ${two} and some more words besides`,
      mine
    );
    const shortTwo = await add(`${one} ${three}`, mine);
    const question = `${one} ${two} ${three}`;
    const before = await recalledAs(reader, question);
    expect(before).toStrictEqual([all, shortTwo, twoWords]);

    // More hidden matches than a recall returns, each holding every word.
    for (let index = 0; index <= recallLimit; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(question, { kind: "owner", personId: other });
    }

    await expect(recalledAs(reader, question)).resolves.toStrictEqual(before);
    await expect(recalledAs(other, question)).resolves.toHaveLength(
      recallLimit
    );
  });

  it("refuses a source whose readers it can't read, and stores nothing of it", async () => {
    const reader = await person();
    const secret = word();
    for (const readers of [
      {},
      { kind: "everyone" },
      { kind: "audience", group: "everyone" },
      { kind: "owner", personId: "" },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await expect(addUnchecked(secret, readers)).rejects.toThrow(refused);
    }
    await expect(
      addUnchecked("", { kind: "owner", personId: reader })
    ).rejects.toThrow(refused);

    await expect(recalledAs(reader, secret)).resolves.toStrictEqual([]);
  });

  it("holds to its bounds: as many teams as a reader may have, and no more", async () => {
    const [atMost, overMost] = await Promise.all([person(), person()]);
    await inTeams(atMost, readerGroupsMax);
    await inTeams(overMost, readerGroupsMax + 1);
    const secret = word();
    const id = await add(secret, { kind: "owner", personId: atMost });

    await expect(recalledAs(atMost, secret)).resolves.toStrictEqual([id]);
    await expect(recalledAs(overMost, secret)).rejects.toThrow(refused);
    await expect(
      add("a".repeat(sourceTextMaxBytes + 1), {
        kind: "owner",
        personId: atMost,
      })
    ).rejects.toThrow(refused);
    await expect(
      recalledAs(atMost, "a".repeat(questionMaxLength + 1))
    ).rejects.toThrow(refused);
  });
});

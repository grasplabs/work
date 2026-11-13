import {
  questionMaxLength,
  readerGroupsMax,
  recallBudgetMax,
  recallLimit,
  sourceTextMaxBytes,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
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

/**
 * What core or the Brain says when it refuses an input: core's own
 * check, the Brain's, or a text the Brain can't keep.
 */
const refused =
  /^(?:The Brain refused it|Refused|There's no text in this to keep|This text is too large for the Brain to keep)/u;

/** What core answers an argument that isn't of the kind its call takes. */
const invalid = { code: "brain.request_invalid" };

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

/** A source of its own, as an upload names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** Adds `text` as a source of its own, answering its identity. */
const add = async (
  text: string,
  readers: SourceReaders
): Promise<SourceRef> => {
  const { source } = await addSource(env, {
    source: newSource(),
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/** What the member `personId` recalls for `question`, by source, best first. */
const recalledAs = async (
  personId: string,
  question: string
): Promise<SourceRef[]> => {
  const { items: chunks } = await recallAs(env, personId, {
    personal: true,
    question,
    budget: { tokens: recallBudgetMax },
  });
  return chunks.map(({ source }) => source);
};

/** Adds `text` for `readers` as given, unchecked, as a caller outside TypeScript could. */
const addUnchecked = async (text: string, readers: unknown): Promise<unknown> =>
  // SAFETY: core and the store check what they are given; these tests
  // hand them what the type rules out, as a call from outside TypeScript
  // could.
  await addSource(env, {
    source: newSource(),
    change: crypto.randomUUID(),
    text,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    readers: readers as SourceReaders,
  });

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
      expect(found).toHaveLength(2);
      expect(found).toStrictEqual(
        expect.arrayContaining([accented, decomposed])
      );
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

    // Where a mark is part of the letter, words that differ by it stay
    // distinct: Japanese "school" and "cuckoo", Devanagari "book" and a
    // word without its vowel sign, Thai "eat" and the same consonants
    // without the vowel.
    for (const [one, other] of [
      ["がっこう", "かっこう"],
      ["किताब", "कताब"],
      ["กิน", "กน"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one pair at a time
      const [first, second] = [await add(one, owner), await add(other, owner)];
      // oxlint-disable-next-line no-await-in-loop -- one pair at a time
      await expect(recalledAs(reader, one)).resolves.toStrictEqual([first]);
      // oxlint-disable-next-line no-await-in-loop -- one pair at a time
      await expect(recalledAs(reader, other)).resolves.toStrictEqual([second]);
    }
    // Hebrew and Arabic vowel marks are optional, as accents are: a pointed
    // word is found by its plain spelling.
    const pointed = await add("שָׁלוֹם", owner);
    await expect(recalledAs(reader, "שלום")).resolves.toStrictEqual([pointed]);
    const vowelled = await add("مُدَرِّسَة", owner);
    await expect(recalledAs(reader, "مدرسة")).resolves.toStrictEqual([
      vowelled,
    ]);
  });

  it("takes a letter with a long run of marks in its stride, and keeps answering", async () => {
    const reader = await person();
    const owner = { kind: "owner", personId: reader } as const;
    await add(`a${"́".repeat(100_000)}`, owner);
    const after = word();
    const id = await add(`Added after it: ${after}`, owner);

    await expect(recalledAs(reader, after)).resolves.toStrictEqual([id]);
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
      { kind: "anyone" },
      { kind: "audience", group: "everyone" },
      { kind: "owner", personId: "" },
      { kind: "owner" },
      { kind: "owner", personId: reader, teamId: "extra" },
      { kind: "team", teamId: "" },
      { kind: "team" },
      { kind: "none", personId: reader },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await expect(addUnchecked(secret, readers)).rejects.toMatchObject(
        invalid
      );
    }
    await expect(
      addUnchecked("", { kind: "owner", personId: reader })
    ).rejects.toThrow(refused);

    await expect(recalledAs(reader, secret)).resolves.toStrictEqual([]);
  });

  it("refuses a recall for an empty or missing person, never answering it with nothing", async () => {
    const asGivenIds: unknown[] = ["", undefined];
    for (const personId of asGivenIds) {
      // SAFETY: what the type rules out, as a call from outside TypeScript
      // could make it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const asGiven = personId as string;
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await expect(
        recallAs(env, asGiven, {
          personal: true,
          question: "anything",
          budget: { tokens: recallBudgetMax },
        })
      ).rejects.toMatchObject(invalid);
    }
  });

  it("refuses a recall when core's own records hold a team with an empty ID", async () => {
    const reader = await person();
    await newTeam("");
    await join("", reader);

    await expect(recalledAs(reader, "anything")).rejects.toMatchObject(invalid);
  });

  it("holds to its bounds: as many teams as a reader's groups hold beside the company, and no more", async () => {
    const [atMost, overMost] = await Promise.all([person(), person()]);
    // A member's reader holds the company's group too.
    await inTeams(atMost, readerGroupsMax - 1);
    await inTeams(overMost, readerGroupsMax);
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
    ).rejects.toMatchObject(invalid);
  });
});

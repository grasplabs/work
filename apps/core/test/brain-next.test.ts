import type {
  NewSource,
  Reader,
  SourceId,
} from "@grasp-os/brain-next/contract";
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
import { brain, brainReader, teamGroup } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// The new Brain's first path (GRA-1720): core adds a source with who may
// read it and recalls it by words, as a reader core resolves from its own
// records, through the Brain's contract into its store. From the threat
// model on the issue: the reader is core's, never the caller's; group
// membership is core's, read at each recall; the question is words, never
// FTS5 syntax; access is checked inside the search, so hidden sources
// neither show, take places nor move the order; malformed access is
// refused whole.

const idp = mockIdp();

/** A word no other test's sources hold. */
const word = () => `w${unique()}`;

/** What the store says when it refuses an input. */
const refused = /^The Brain refused it/u;

/** A member of the organization, signed in. */
const person = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** A team of the organization. */
const newTeam = async (): Promise<string> => {
  const id = crypto.randomUUID();
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

const add = async (source: NewSource): Promise<SourceId> => {
  const { id } = await brain(env).addSource(source);
  return id;
};

/** What `reader` recalls for `question`, by ID, best first. */
const recalledBy = async (
  reader: Reader,
  question: string
): Promise<SourceId[]> => {
  const { sources } = await brain(env).recall({ question, reader });
  return sources.map(({ id }) => id);
};

/** What the member `personId` recalls for `question`, as core reads them now. */
const recalledAs = async (
  personId: string,
  question: string
): Promise<SourceId[]> =>
  await recalledBy(await brainReader(env, personId), question);

/** Adds `source` as given, unchecked, as a caller outside TypeScript could. */
const addUnchecked = async (source: unknown): Promise<unknown> =>
  // SAFETY: the store checks what it is given; these tests hand it what
  // the type rules out, as a call from outside TypeScript could.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  await brain(env).addSource(source as NewSource);

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
    const id = await add({
      text: `Salary review for ${secret}`,
      access: { kind: "owner", person: owner },
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
    await add({ text: `Unknown readers ${secret}`, access: { kind: "none" } });
    await add({ text: `Unknown readers ${secret}`, access: { kind: "none" } });

    await expect(recalledAs(someone, secret)).resolves.toStrictEqual([]);
    await expect(recalledAs(member, secret)).resolves.toStrictEqual([]);
  });

  it("follows a team's membership as core keeps it, with no call to the Brain between", async () => {
    const [newcomer, stayer] = await Promise.all([person(), person()]);
    const team = await newTeam();
    await join(team, stayer);
    const handbook = word();
    const id = await add({
      text: `The ${handbook} handbook`,
      access: { kind: "audience", group: teamGroup(team) },
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
    await add({ text: secret, access: { kind: "owner", person: removed } });
    await expect(recalledAs(removed, secret)).resolves.toHaveLength(1);

    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(removed)
      .run();
    await expect(brainReader(env, removed)).rejects.toMatchObject({
      code: "permission.person_inactive",
    });
  });

  it("keeps a person and a group of the same name apart", async () => {
    const name = word();
    const secret = word();
    const asPerson = await add({
      text: secret,
      access: { kind: "owner", person: name },
    });
    const asGroup = await add({
      text: secret,
      access: { kind: "audience", group: name },
    });

    await expect(
      recalledBy({ person: name, groups: [] }, secret)
    ).resolves.toStrictEqual([asPerson]);
    await expect(
      recalledBy({ person: word(), groups: [name] }, secret)
    ).resolves.toStrictEqual([asGroup]);
  });

  it("reads a question as words, never as search syntax", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const mine = word();
    const theirs = word();
    const id = await add({
      text: `Invoice ${mine}`,
      access: { kind: "owner", person: reader },
    });
    const hidden = await add({
      text: `Payroll ${theirs} ${mine}x`,
      access: { kind: "owner", person: other },
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

  it("matches whole words regardless of case and accents", async () => {
    const reader = await person();
    const tag = word();
    const id = await add({
      text: `De FINANCIËLE regeling ${tag}`,
      access: { kind: "owner", person: reader },
    });

    await expect(
      recalledAs(reader, `financiele ${tag}`)
    ).resolves.toStrictEqual([id]);
    await expect(recalledAs(reader, `Financiële`)).resolves.toContain(id);
  });

  it("ranks on a source's own words, so hidden sources neither take places nor move the order", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const [one, two, three] = [word(), word(), word()];
    const all = await add({
      text: `${one} ${two} ${three}`,
      access: { kind: "owner", person: reader },
    });
    const twoWords = await add({
      text: `${one} ${two} and some more words besides`,
      access: { kind: "owner", person: reader },
    });
    const shortTwo = await add({
      text: `${one} ${three}`,
      access: { kind: "owner", person: reader },
    });
    const question = `${one} ${two} ${three}`;
    const before = await recalledAs(reader, question);
    expect(before).toStrictEqual([all, shortTwo, twoWords]);

    // More hidden matches than a recall returns, each holding every word.
    for (let index = 0; index <= recallLimit; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add({ text: question, access: { kind: "owner", person: other } });
    }

    await expect(recalledAs(reader, question)).resolves.toStrictEqual(before);
    await expect(recalledAs(other, question)).resolves.toHaveLength(
      recallLimit
    );
  });

  it("refuses a source whose readers it can't read, and stores nothing of it", async () => {
    const reader = await person();
    const secret = word();
    for (const access of [
      undefined,
      {},
      { kind: "everyone" },
      { kind: "owner" },
      { kind: "owner", person: "" },
      { kind: "audience", group: "" },
      { kind: "owner", person: reader, group: "extra" },
      { kind: "none", person: reader },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await expect(addUnchecked({ text: secret, access })).rejects.toThrow(
        refused
      );
    }
    await expect(
      addUnchecked({
        text: secret,
        access: { kind: "owner", person: reader },
        readers: ["everyone"],
      })
    ).rejects.toThrow(refused);

    await expect(recalledAs(reader, secret)).resolves.toStrictEqual([]);
  });

  it("refuses what is over its bounds", async () => {
    const reader = await person();
    await expect(
      add({
        text: "a".repeat(sourceTextMaxBytes + 1),
        access: { kind: "owner", person: reader },
      })
    ).rejects.toThrow(refused);
    await expect(
      recalledBy(
        await brainReader(env, reader),
        "a".repeat(questionMaxLength + 1)
      )
    ).rejects.toThrow(refused);
    await expect(
      recalledBy(
        {
          person: reader,
          groups: Array.from({ length: readerGroupsMax + 1 }, (_, index) =>
            String(index)
          ),
        },
        "anything"
      )
    ).rejects.toThrow(refused);
  });
});

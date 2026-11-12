import {
  exactCandidatesMax,
  packItemTokens,
  recallBudgetMax,
  recallLimit,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, readSourceVersionAs, recallAs } from "../src/brain-next.ts";
import type {
  RecalledPack,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// The cited pack (GRA-1728), through core's `recallAs` into the Brain's
// store. From the threat list on the issue: an exact ID or quoted phrase
// is found however low word search ranks it; a pack never passes
// its budget and says when the budget cut it short; every item cites a
// version its reader may read, now or as of a moment, by the rule
// `readSourceVersionAs` follows; and what a pack says was not found, or
// cut short, is the same for a reader without access to a source as in a
// store without it. The permission harness (brain-next-surfaces.ts)
// probes the same with markers, and the random test
// (brain-next-random.test.ts) holds the order to a brute-force answer.

const idp = mockIdp();

/** A word no other test's sources hold, without a digit: no ID. */
const word = (): string =>
  `w${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 10)}`;

/** An ID no other test's sources hold. */
const id = (): string =>
  `INV-${crypto.getRandomValues(new Uint32Array(1))[0] ?? 0}`;

const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

const person = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

const teamOf = async (...members: string[]): Promise<string> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${teamId}`,
    organizationId,
    createdAt: new Date(),
  });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      createdAt: new Date(),
    });
  }
  return teamId;
};

const owner = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

const team = (teamId: string): SourceReaders => ({ kind: "team", teamId });

/** Adds `text` as the next version of `source` (a new one by default). */
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

/** The pack `personId` gets, at the largest budget unless one is given. */
const packFor = async (
  personId: string,
  question: string,
  { tokens = recallBudgetMax, asOf }: { tokens?: number; asOf?: Date } = {}
): Promise<RecalledPack> =>
  await recallAs(env, personId, {
    personal: true,
    question,
    budget: { tokens },
    ...(asOf === undefined ? {} : { asOf }),
  });

/** The first hour of the as-of test's clock. */
const start = Date.UTC(2026, 0, 1);

const hourMs = 3_600_000;

/** `hours` past `start`. */
const hoursIn = (hours: number): Date => new Date(start + hours * hourMs);

/**
 * Adds as `add` does with the clock at `hours` past `start`: the store
 * runs in this isolate, so its `new Date()` is the one faked here, and
 * each version's added time is exactly the one set.
 */
const addAt = async (
  hours: number,
  ...adding: Parameters<typeof add>
): Promise<SourceRef> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(hoursIn(hours));
  try {
    return await add(...adding);
  } finally {
    vi.useRealTimers();
  }
};

/** The tokens `pack`'s items take of its budget, as the Brain counts them. */
const spent = (pack: RecalledPack): number => {
  let tokens = 0;
  for (const item of pack.items) {
    tokens += packItemTokens({ ...item, source: `upload:${item.source.id}` });
  }
  return tokens;
};

/** `pack`'s item citing `source`, if any. */
const quoted = (pack: RecalledPack, source: SourceRef) =>
  pack.items.find((item) => item.source.id === source.id);

describe("the cited pack", () => {
  it("finds an exact ID and a quoted phrase that word search ranks past its limit", async () => {
    const reader = await person();
    const [topic, other] = [word(), word()];
    const invoice = id();
    // More passages than a list holds, each with more of the question's
    // words than the one that answers it.
    for (let index = 0; index <= recallLimit; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(
        `${topic} ${other} invoice payment terms supplier delivery, the rota for the night shift, number ${index}.`,
        owner(reader)
      );
    }
    const byId = await add(
      `Paid: ${invoice.replace("-", " ")}.`,
      owner(reader)
    );
    const byPhrase = await add(
      `${topic}: the night shift rota is posted on Fridays.`,
      owner(reader)
    );

    const [idPack, phrasePack] = await Promise.all([
      packFor(
        reader,
        `${topic} ${other} invoice payment terms supplier delivery ${invoice}`
      ),
      packFor(
        reader,
        `${topic} ${other} invoice payment terms "night shift rota"`
      ),
    ]);

    expect({ id: idPack.items[0], phrase: phrasePack.items[0] }).toMatchObject({
      id: { source: byId, found: "exact" },
      phrase: { source: byPhrase, found: "exact" },
    });
    expect([idPack, phrasePack].map(({ notFound }) => notFound)).toStrictEqual([
      [],
      [],
    ]);
  });

  it("finds an ID past more chunks than the exact way checks of another ID, a year among them, and still says a third ID was not found", async () => {
    const reader = await person();
    const [topic, other] = [word(), word()];
    const [invoice, common, missing] = [id(), id(), id()];
    // More short chunks than the cap holding the common ID and the year,
    // each shorter than the invoice's and as likely to hold the ID in a
    // row: the common ID is capped, with a cap of its own, so the
    // invoice's is never crowded out; the year is a plain word.
    for (let index = 0; index <= exactCandidatesMax + 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(`Ref ${common} due 2026`, owner(reader));
    }
    // And more chunks than a list holds with more of the question's words
    // than the invoice's: word search ranks it past its limit.
    for (let index = 0; index <= recallLimit; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(`${topic} ${other} paid 2026, number ${index}.`, owner(reader));
    }
    const byId = await add(
      `A longer note: order ${invoice} was booked in full on time.`,
      owner(reader)
    );

    const [found, notFound] = await Promise.all([
      packFor(reader, `${topic} ${other} paid ${invoice} ${common} in 2026`),
      packFor(reader, `${topic} ${other} paid ${missing} ${common} in 2026`),
    ]);

    // First in its own part's list, tied there with the common ID's first
    // and the words way's first, the common ID's list before it.
    expect(
      found.items.slice(0, 3).find(({ source }) => source.id === byId.id)
    ).toMatchObject({ source: byId, found: "exact" });
    // The capped ID is never said to be missing, nor the year, a word
    // found; the missing ID is.
    expect({ found: found.notFound, missing: notFound.notFound }).toStrictEqual(
      { found: [], missing: [missing] }
    );
  });

  it("reads a date, a time and a word with one digit as words: the passage writing them otherwise comes first, and none is said not found", async () => {
    const reader = await person();
    const [topic, other] = [word(), word()];
    const signed = await add(
      `The ${topic} contract was signed on 14 maart 2026 at 9.30.`,
      owner(reader)
    );
    const quarter = await add(
      `De omzet van ${other} in het tweede kwartaal steeg.`,
      owner(reader)
    );
    // A dozen log lines holding the date, the time and "2e" as written:
    // as IDs, each would have a list of its own, first in the fusion.
    for (let index = 0; index < 12; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(
        `log ${topic} ${other} 2026-03-14 09:30 2e run ${index}`,
        owner(reader)
      );
    }

    const [bySigning, byQuarter, missed] = await Promise.all([
      packFor(
        reader,
        `when was the ${topic} contract signed on 2026-03-14 09:30`
      ),
      packFor(reader, `omzet ${other} 2e kwartaal`),
      packFor(
        reader,
        `was the ${topic} contract signed on 2026-03-15 at 09:30`
      ),
    ]);

    expect({
      bySigning: bySigning.items[0]?.source,
      byQuarter: byQuarter.items[0]?.source,
    }).toStrictEqual({ bySigning: signed, byQuarter: quarter });
    expect(
      [bySigning, byQuarter, missed].flatMap(({ notFound }) =>
        notFound.filter((part) =>
          ["2026-03-14", "2026-03-15", "09:30", "2e"].includes(part)
        )
      )
    ).toStrictEqual([]);
  });

  it("reads IDs a question lists with commas, semicolons or sentence punctuation one by one", async () => {
    const reader = await person();
    const [first, second, third] = [id(), id(), id()];
    const byFirst = await add(`Booked: ${first}.`, owner(reader));
    const bySecond = await add(`Paid: ${second}.`, owner(reader));
    const byThird = await add(`Sent: ${third}.`, owner(reader));

    const packs = await Promise.all(
      [
        `${first},${second}`,
        `${first}; ${second}`,
        `Where is ${third}.`,
        `Where is (${third})?`,
      ].map(async (question) => await packFor(reader, question))
    );

    expect(
      packs.map(({ items, notFound }) => ({
        exact: items
          .filter(({ found }) => found === "exact")
          .map(({ source }) => source.id)
          .toSorted(),
        notFound,
      }))
    ).toStrictEqual([
      { exact: [byFirst.id, bySecond.id].toSorted(), notFound: [] },
      { exact: [byFirst.id, bySecond.id].toSorted(), notFound: [] },
      { exact: [byThird.id], notFound: [] },
      { exact: [byThird.id], notFound: [] },
    ]);
  });

  it("quotes a phrase or an ID a long sentence holds across where it would be cut, within the budget", async () => {
    const reader = await person();
    const [topic, other] = [word(), word()];
    const invoice = id();
    // One sentence of 1,500 characters, no punctuation, the phrase and
    // the ID across character 400, where a long sentence is cut.
    const sentence = (held: string): string => {
      const before = `${topic} `.repeat(Math.ceil(395 / (topic.length + 1)));
      return `${before.slice(0, 395 - 1)} ${held} ${`${other} `.repeat(200)}`
        .slice(0, 1500)
        .trim();
    };
    const phrased = sentence("night shift rota");
    const ided = sentence(invoice);
    const [byPhrase, byId] = [
      await add(phrased, owner(reader)),
      await add(ided, owner(reader)),
    ];
    const tokens = 200;

    const [phrasePack, idPack] = await Promise.all([
      packFor(reader, `"night shift rota" ${topic}`, { tokens }),
      packFor(reader, `${invoice} ${topic}`, { tokens }),
    ]);

    expect({
      phrase: quoted(phrasePack, byPhrase)?.text.includes("night shift rota"),
      phraseIn: phrased.includes(quoted(phrasePack, byPhrase)?.text ?? "-"),
      id: quoted(idPack, byId)?.text.includes(invoice),
      idIn: ided.includes(quoted(idPack, byId)?.text ?? "-"),
      found: [quoted(phrasePack, byPhrase)?.found, quoted(idPack, byId)?.found],
      whole: [quoted(phrasePack, byPhrase)?.whole, quoted(idPack, byId)?.whole],
      spent: [spent(phrasePack) <= tokens, spent(idPack) <= tokens],
    }).toStrictEqual({
      phrase: true,
      phraseIn: true,
      id: true,
      idIn: true,
      found: ["exact", "exact"],
      whole: [false, false],
      spent: [true, true],
    });
  });

  it("finds a phrase held in a row in a longer chunk past more chunks than the cap that hold its words apart", async () => {
    const reader = await person();
    const [first, second] = [word(), word()];
    for (let index = 0; index <= exactCandidatesMax + 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(`${second} q ${first} i`, owner(reader));
    }
    const inARow = await add(
      `Here, in a longer chunk, ${first} ${second} stand in a row, as asked.`,
      owner(reader)
    );

    const pack = await packFor(reader, `"${first} ${second}"`);

    expect(pack.items[0]).toMatchObject({ source: inARow, found: "exact" });
    expect(pack.notFound).toStrictEqual([]);
  });

  it("never passes its budget, with text of several scripts and a passage larger than the whole budget, and says when it was cut short", async () => {
    const reader = await person();
    const topic = word();
    // A paragraph of one sentence far over a quote, and one of many
    // sentences, in scripts of one to four bytes a character.
    await add(
      `${topic} ${"请求书 договор financiële 🧾 ".repeat(120)}`,
      owner(reader)
    );
    await add(
      Array.from(
        { length: 30 },
        (_, index) => `Sentence ${index} about ${topic}, Rechnung über 𝔉𝔞𝔨𝔱𝔲𝔯.`
      ).join(" "),
      owner(reader)
    );

    const budgets = [1, 5, 20, 60, 150, 400, 1000, recallBudgetMax];
    const packs = await Promise.all(
      budgets.map(async (tokens) => await packFor(reader, topic, { tokens }))
    );

    for (const [index, pack] of packs.entries()) {
      const budget = budgets[index] ?? 0;
      expect(spent(pack), `${budget} tokens`).toBeLessThanOrEqual(budget);
      expect(pack.truncated, `${budget} tokens`).toBe(
        pack.items.length < 2 || pack.items.some(({ whole }) => !whole)
      );
    }
    // Nothing fits one token; everything, whole, the most.
    expect(
      [packs[0], packs.at(-1)].map((pack) => ({
        items: pack?.items.length,
        whole: pack?.items.every(({ whole }) => whole),
        truncated: pack?.truncated,
      }))
    ).toStrictEqual([
      { items: 0, whole: true, truncated: true },
      { items: 2, whole: true, truncated: false },
    ]);
    // A budget that takes both quotes but not the long passage whole.
    expect(
      packs.some(
        ({ items }) => items.length === 2 && items.some(({ whole }) => !whole)
      )
    ).toBeTruthy();
  });

  it("cites only versions the reader may read, current or as of a moment, each holding the item's text", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const together = await teamOf(reader, other);
    const topic = word();
    // Rewritten: as of before the rewrite, the first text, cited as v1.
    const rewritten = await addAt(1, `${topic} first draft`, team(together));
    const beforeRewrite = hoursIn(1.5);
    await addAt(2, `${topic} final text`, team(together), rewritten);
    // Narrowed away from the reader: never theirs again, then or now.
    const narrowed = await addAt(3, `${topic} narrowed draft`, team(together));
    const beforeNarrowing = hoursIn(3.5);
    await addAt(4, `${topic} narrowed final`, owner(other), narrowed);
    // Widened to the reader: what came before was never theirs.
    const widened = await addAt(5, `${topic} widened draft`, owner(other));
    const beforeWidening = hoursIn(5.5);
    await addAt(6, `${topic} widened final`, team(together), widened);
    // The moment of the last version itself: the bound includes it.
    const atTheLastVersion = hoursIn(6);

    const cited = async (asOf?: Date) => {
      const { items } = await packFor(
        reader,
        topic,
        asOf === undefined ? {} : { asOf }
      );
      return await Promise.all(
        items.map(async ({ source, version, text }) => {
          const read = await readSourceVersionAs(env, reader, {
            source,
            version,
          });
          return {
            source,
            version,
            text,
            readable: read?.text.includes(text) ?? false,
          };
        })
      );
    };
    const of = (source: SourceRef, version: number, text: string) => ({
      source,
      version,
      text: `${topic} ${text}`,
      readable: true,
    });

    expect({
      now: await cited(),
      beforeRewrite: await cited(beforeRewrite),
      beforeNarrowing: await cited(beforeNarrowing),
      beforeWidening: await cited(beforeWidening),
      atTheLast: await cited(atTheLastVersion),
      beforeAnything: await cited(new Date(0)),
    }).toStrictEqual({
      now: [of(rewritten, 2, "final text"), of(widened, 2, "widened final")],
      beforeRewrite: [of(rewritten, 1, "first draft")],
      beforeNarrowing: [of(rewritten, 2, "final text")],
      beforeWidening: [of(rewritten, 2, "final text")],
      atTheLast: [
        of(rewritten, 2, "final text"),
        of(widened, 2, "widened final"),
      ],
      beforeAnything: [],
    });
  });

  it("says what was not found, from what the reader may read alone: as in a store where the hidden source doesn't exist", async () => {
    const [reader, holder] = await Promise.all([person(), person()]);
    const [topic, hidden, absent] = [word(), word(), word()];
    const [hiddenId, absentId] = [id(), id()];
    const ours = await add(`${topic} is ours. Ours alone.`, owner(reader));
    for (let index = 0; index < 3; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(
        `${topic} ${hidden} ${hiddenId} secret ${index}`,
        owner(holder)
      );
    }

    const ask = (words: string, ids: string): string =>
      `Where is ${topic} ${words} "${words} plan" ${ids} of 14 maart 2026?`;
    const packs = await Promise.all(
      [1, 12, recallBudgetMax].flatMap((tokens) => [
        packFor(reader, ask(hidden, hiddenId), { tokens }),
        packFor(reader, ask(absent, absentId), { tokens }),
      ])
    );

    for (let index = 0; index < packs.length; index += 2) {
      const [asHidden, asAbsent] = [packs[index], packs[index + 1]];
      if (asHidden === undefined || asAbsent === undefined) {
        throw new Error("Packs come in pairs");
      }
      expect(
        JSON.stringify(asHidden)
          .replaceAll(hidden, absent)
          .replaceAll(hiddenId, absentId)
      ).toBe(JSON.stringify(asAbsent));
    }
    expect(packs.at(-2)).toStrictEqual({
      items: [
        {
          source: ours,
          version: 1,
          position: 0,
          text: `${topic} is ours. Ours alone.`,
          whole: true,
          found: "words",
        },
      ],
      // A date is words: found apart, or not, as any word.
      notFound: [
        `${hidden} plan`,
        hiddenId,
        hidden,
        "plan",
        "14",
        "maart",
        "2026",
      ],
      truncated: false,
    });
  });

  it("finds by the question's commonest words alone only as such, and says its telling words were not found", async () => {
    const reader = await person();
    const absent = word();
    const source = await add(
      `${word()} wie kan me met het rooster`,
      owner(reader)
    );

    const pack = await packFor(reader, `wie me met ${absent}`);

    expect(
      pack.items.find((item) => item.source.id === source.id)
    ).toMatchObject({
      found: "stop words",
    });
    expect(pack.notFound).toStrictEqual([absent]);
  });
});

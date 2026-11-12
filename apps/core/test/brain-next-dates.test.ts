import {
  exactCandidatesMax,
  packItemTokens,
  recallBudgetMax,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { addSource, recallAs, workBrain } from "../src/brain-next.ts";
import type {
  RecalledPack,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// Dates found however a source writes them (GRA-1798), through core's
// `recallAs`: each passage's calendar days are read where it is indexed,
// by the closed table of dates.ts, and a question's date finds the
// passages writing that day in any of the table's forms, as one more list
// in the fusion. From the design note on the issue: the old recogniser's
// two failures (a common date crowding out an ID or a phrase; a source
// writing the day otherwise not found, and the date said not to be
// there), a date not found only when no readable passage writes the day,
// the same for a reader without access as for a store without the
// source, and the days of an older store's passages filled by the word
// index's rebuild.

const idp = mockIdp();

/** A word no other test's sources hold, without a digit. */
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

const owner = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

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

const packFor = async (
  personId: string,
  question: string,
  tokens = recallBudgetMax
): Promise<RecalledPack> =>
  await recallAs(env, personId, { question, budget: { tokens } });

/** The sources a pack cites as found by their date or exact part. */
const exactIn = (pack: RecalledPack): string[] =>
  pack.items
    .filter(({ found }) => found === "exact")
    .map(({ source }) => source.id);

/** The Brain's one store. */
const store = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

describe("dates, however a source writes them", { timeout: 120_000 }, () => {
  it("finds a passage writing the day as an ordinal, with a month name in any of the five languages, as ISO with a time, without a year, or the other way round", async () => {
    const reader = await person();
    const written = [
      "Signed on the 14th March 2026.",
      "Getekend op 14 maart.",
      "Logged at 2026-03-14T09:00:00Z.",
      "Unterschrieben am 14. März 2026.",
      "Signé le 14 mars 2026.",
      "Firmado el 14 de marzo de 2026.",
      "Signed March 14th, 2026.",
    ];
    const sources = [];
    for (const text of written) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      sources.push(await add(text, owner(reader)));
    }
    // Valid both ways: 3 April and 4 March.
    const bothWays = await add("Delivered 03/04/2026.", owner(reader));

    const [asIso, asWords, april, march] = await Promise.all([
      packFor(reader, "What happened on 2026-03-14?"),
      packFor(reader, "Wat gebeurde er op 14 maart 2026?"),
      packFor(reader, "What came on 3 April 2026?"),
      packFor(reader, "Was kam am 4. März 2026?"),
    ]);

    const ids = sources.map((source) => source.id).toSorted();
    expect({
      asIso: exactIn(asIso).toSorted(),
      asWords: exactIn(asWords).toSorted(),
      april: exactIn(april),
      march: exactIn(march),
      notFound: [asIso, asWords, april, march].map(({ notFound }) => notFound),
    }).toStrictEqual({
      asIso: ids,
      asWords: ids,
      april: [bothWays.id],
      march: [bothWays.id],
      // The question's other words, never its date.
      notFound: [["happened"], ["gebeurde"], ["came"], ["kam"]],
    });
  });

  it("never lets a common date push an ID or a quoted phrase out of first place", async () => {
    const reader = await person();
    const invoice = id();
    // More passages writing the day than the date way checks of it.
    for (let index = 0; index <= exactCandidatesMax + 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(`Log ${index} on 14 maart 2026.`, owner(reader));
    }
    const byId = await add(`${invoice} was paid.`, owner(reader));
    const byPhrase = await add(
      "The night shift rota was posted.",
      owner(reader)
    );

    const [idPack, phrasePack] = await Promise.all([
      packFor(reader, `When was ${invoice} paid on 14 maart 2026?`),
      packFor(
        reader,
        `When was the "night shift rota" posted on 14 maart 2026?`
      ),
    ]);

    expect({
      id: idPack.items[0]?.source,
      phrase: phrasePack.items[0]?.source,
      // The day's list is capped: never said not found.
      notFound: [idPack.notFound, phrasePack.notFound],
    }).toStrictEqual({
      id: byId,
      phrase: byPhrase,
      notFound: [[], []],
    });
  });

  it("names a date not found only when no passage the reader may read writes the day, as in a store where the hidden source doesn't exist", async () => {
    const [reader, holder] = await Promise.all([person(), person()]);
    const topic = word();
    await add(`${topic} met on 2 June 2031.`, owner(reader));
    // Only the holder's sources write 17 June 2031, more of them than the
    // date way checks: its cap counts what the reader may read alone.
    for (let index = 0; index <= exactCandidatesMax; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(`${topic} secret ${index} on 17 juni 2031.`, owner(holder));
    }

    const packs = await Promise.all(
      [1, 30, recallBudgetMax].flatMap((tokens) => [
        packFor(reader, `What about ${topic} on 2031-06-17?`, tokens),
        packFor(reader, `What about ${topic} on 2031-06-18?`, tokens),
      ])
    );

    for (let index = 0; index < packs.length; index += 2) {
      expect(
        JSON.stringify(packs[index]).replaceAll("2031-06-17", "2031-06-18")
      ).toBe(JSON.stringify(packs[index + 1]));
    }
    expect(packs.at(-2)?.notFound).toStrictEqual(["2031-06-17"]);
  });

  it("quotes the date as the passage writes it, past where a long sentence is cut, within the budget", async () => {
    const reader = await person();
    const topic = word();
    const filler = `${topic} `.repeat(120);
    const text =
      `${filler}signed on 14 maart 2026 ${`${word()} `.repeat(120)}`.trim();
    const source = await add(text, owner(reader));
    const tokens = 200;

    const pack = await packFor(reader, `${topic} on 2026-03-14`, tokens);
    const item = pack.items.find((one) => one.source.id === source.id);

    expect({
      holds: item?.text.includes("14 maart 2026"),
      within: text.includes(item?.text ?? "-"),
      whole: item?.whole,
      found: item?.found,
      spent:
        pack.items.reduce(
          (sum, one) =>
            sum + packItemTokens({ ...one, source: `upload:${one.source.id}` }),
          0
        ) <= tokens,
    }).toStrictEqual({
      holds: true,
      within: true,
      whole: false,
      found: "exact",
      spent: true,
    });
  });

  it("gives the passages of an older store their days once the word index's rebuild reaches them", async () => {
    const reader = await person();
    const source = await add("Due on 9 septembre 2033.", owner(reader));
    // As a store from before days were indexed: none, and its word index
    // at the rules before them.
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM chunk_days");
      state.storage.sql.exec(
        "UPDATE word_index SET version = 2, target = 2, cursor = 0"
      );
    });
    const before = exactIn(await packFor(reader, "2033-09-09"));
    let at = Date.now();
    for (let tick = 0; tick < 100; tick += 1) {
      at += 60_000;
      // oxlint-disable-next-line no-await-in-loop -- one tick at a time
      await workBrain(env, new Date(at));
      // oxlint-disable-next-line no-await-in-loop -- one tick at a time
      const version = await runInDurableObject(
        store(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ version: number }>("SELECT version FROM word_index")
            .one().version
      );
      if (version === 3) {
        break;
      }
    }

    expect({
      before,
      after: exactIn(await packFor(reader, "2033-09-09")),
    }).toStrictEqual({ before: [], after: [source.id] });
  });
});

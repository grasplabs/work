import { describe, expect, it } from "vite-plus/test";

import {
  absent,
  answer,
  brainEvalLanguages,
  hidden,
} from "./fixtures/brain-eval/company.ts";
import type {
  BrainEvalPerson,
  BrainEvalQuestion,
  BrainEvalSource,
} from "./fixtures/brain-eval/company.ts";
import {
  brainEvalSet,
  grepRecall,
  isLongDocument,
  leaksOf,
  passagesDigestOf,
  passagesOf,
  questionDigestOf,
  rankOf,
  setDigestOf,
  setProblems,
  sourceRankOf,
} from "./fixtures/brain-eval/set.ts";
import type { BrainEvalSet, Returned } from "./fixtures/brain-eval/set.ts";

// The Brain evaluation's own checks (fixtures/brain-eval/set.ts): what
// counts as a leak, the one hard gate, where the passage that answers a
// question ranks, how the grep baseline ranks passages, and what makes a
// set broken. Pure functions over constructed results and sets; the
// evaluation itself runs on request only (brain-eval.test.ts).

const { sources } = brainEvalSet;

const textOf = (key: string): string => {
  const source = sources.find((each) => each.key === key);
  if (source === undefined) {
    throw new Error(`No source ${key}`);
  }
  return source.text;
};

/** `keys` returned as the set holds them, best first. */
const returned = (...keys: string[]): Returned => ({
  keys,
  texts: keys.map(textOf),
});

const asking = (
  asker: BrainEvalPerson,
  expects: BrainEvalQuestion["expects"]
): BrainEvalQuestion => ({
  id: "constructed",
  language: "nl",
  question: "?",
  asker,
  expects,
});

/** Daan, in Planning and everyone's team, asking for the salary note. */
const daanAsksHidden = asking(
  "daan",
  hidden("nl-salaris-daan", "3.980", "schaal 7, trede 4")
);

/**
 * A paragraph of exactly `length` characters: `sentence`, then filler. At
 * 700 characters or more, two never fit one chunk, so each paragraph of a
 * constructed document is a passage of its own.
 */
const paragraph = (sentence: string, length: number): string =>
  `${sentence} ${".".repeat(length - sentence.length - 1)}`;

const leaveUtrecht = paragraph(
  "Verlof: elke medewerker heeft 25 vakantiedagen per jaar in Utrecht.",
  700
);
const leaveDuisburg = paragraph(
  "Verlof in Duisburg: daar gelden 28 vakantiedagen per jaar.",
  750
);
const sickness = paragraph(
  "Ziekte: meld je voor 9 uur bij je leidinggevende.",
  800
);

/** A long document of three passages, one per paragraph. */
const handbook: BrainEvalSource = {
  key: "handbook",
  language: "nl",
  readers: { team: "everyone" },
  text: [leaveUtrecht, leaveDuisburg, sickness].join("\n\n"),
};

const memo: BrainEvalSource = {
  key: "memo",
  language: "nl",
  readers: { team: "everyone" },
  text: "Memo: de kantine sluit vrijdag om 15 uur.",
};

const salary: BrainEvalSource = {
  key: "salary",
  language: "nl",
  readers: { team: "hr" },
  text: "Salaris Daan: schaal 7, trede 4, € 3.980 bruto.",
};

const constructedSources = [handbook, memo, salary];

const leaveInUtrecht = asking(
  "eva",
  answer(
    "words",
    "handbook",
    "25 vakantiedagen per jaar in Utrecht",
    "28 vakantiedagen per jaar"
  )
);

const salaryHidden: BrainEvalQuestion = {
  ...asking("daan", hidden("salary", "3.980")),
  id: "salary-hidden",
};

/** `question` asking for `quote` in the handbook, with `lookalike`. */
const quoting = (quote: string, lookalike?: string): BrainEvalQuestion => ({
  ...asking("eva", answer("words", "handbook", quote, lookalike)),
  id: "quoting",
});

const whitespace = /\s+/u;

/** The words of `text`, in order, whatever whitespace parts them. */
const wordsOf = (text: string): string[] => text.split(whitespace);

/** A one-line note everyone may read, ending in `mark`. */
const note = (key: string, mark: string): BrainEvalSource => ({
  key,
  language: "nl",
  readers: { team: "everyone" },
  text: `Kantine: vrijdag dicht ${mark}.`,
});

describe("the Brain evaluation's checks", () => {
  it("finds the set itself sound", () => {
    expect(setProblems(sources, brainEvalSet.questions)).toStrictEqual([]);
  });

  it("finds nothing to report in sources the asker may read", () => {
    expect(
      leaksOf(sources, daanAsksHidden, returned("nl-verlof", "nl-scanners"))
    ).toStrictEqual([]);
  });

  it("reports another person's own source, a team's the asker isn't in, and one nobody may read", () => {
    expect(
      leaksOf(
        sources,
        daanAsksHidden,
        returned("en-credit-facility", "nl-reorganisatie", "nl-overname")
      )
    ).toStrictEqual([
      "unreadable:en-credit-facility",
      "unreadable:nl-reorganisatie",
      "unreadable:nl-overname",
    ]);
  });

  it("reports a source the set doesn't hold", () => {
    expect(
      leaksOf(sources, daanAsksHidden, { keys: [undefined], texts: ["…"] })
    ).toStrictEqual(["unknown"]);
  });

  it("reports a hidden answer's secret inside a text the asker may read", () => {
    expect(
      leaksOf(sources, daanAsksHidden, {
        keys: ["nl-verlof"],
        texts: [`${textOf("nl-verlof")} Daan krijgt € 3.980.`],
      })
    ).toStrictEqual(["secret:3.980"]);
  });

  it("ranks the question's source where it is returned, even below the result budget", () => {
    const question = asking(
      "eva",
      answer("words", "nl-verlof", "25 vakantiedagen per jaar")
    );
    const others = [
      "nl-ziekte",
      "nl-fiets",
      "nl-magazijn",
      "en-travel",
      "de-urlaub",
    ];
    expect(rankOf(question, returned(...others, "nl-verlof"))).toBe(6);
    expect(rankOf(question, returned(...others))).toBeNull();
  });

  it("doesn't count the source when the text returned for it lacks the answer", () => {
    const question = asking(
      "eva",
      answer("words", "nl-verlof", "25 vakantiedagen per jaar")
    );
    expect(
      rankOf(question, { keys: ["nl-verlof"], texts: ["Verlofregeling"] })
    ).toBeNull();
  });

  it("ranks only the passage that holds the quote, and the source at its first passage", () => {
    const otherPassageFirst: Returned = {
      keys: ["handbook", "memo", "handbook"],
      texts: [leaveDuisburg, memo.text, leaveUtrecht],
    };
    expect(rankOf(leaveInUtrecht, otherPassageFirst)).toBe(3);
    expect(sourceRankOf(leaveInUtrecht, otherPassageFirst)).toBe(1);
    const otherPassageOnly: Returned = {
      keys: ["memo", "handbook"],
      texts: [memo.text, leaveDuisburg],
    };
    expect(rankOf(leaveInUtrecht, otherPassageOnly)).toBeNull();
    expect(sourceRankOf(leaveInUtrecht, otherPassageOnly)).toBe(2);
    expect(sourceRankOf(asking("eva", absent), otherPassageFirst)).toBeNull();
  });

  it("searches passages, returning the one of a long document that holds the words, with its own text", () => {
    const found = grepRecall(
      passagesOf(constructedSources),
      "eva",
      "Hoeveel vakantiedagen per jaar in Utrecht?",
      10
    );
    expect(found.keys[0]).toBe("handbook");
    expect(found.texts[0]).toBe(leaveUtrecht);
    expect(found.texts).not.toContain(handbook.text);
  });

  it("puts the shorter of two passages holding as many of the words first", () => {
    expect(
      grepRecall(passagesOf(constructedSources), "eva", "Duisburg Utrecht", 10)
    ).toStrictEqual({
      keys: ["handbook", "handbook"],
      texts: [leaveUtrecht, leaveDuisburg],
    });
  });

  it("never searches a passage the asker may not read", () => {
    const passages = passagesOf(constructedSources);
    const question = "Salaris schaal trede Daan";
    expect(grepRecall(passages, "eva", question, 10).keys).toStrictEqual([
      "salary",
    ]);
    expect(grepRecall(passages, "daan", question, 10).keys).toStrictEqual([]);
  });

  it("finds a constructed set with a long document sound", () => {
    expect(isLongDocument(handbook)).toBeTruthy();
    expect(isLongDocument(memo)).toBeFalsy();
    expect(passagesOf([handbook]).map(({ text }) => text)).toStrictEqual([
      leaveUtrecht,
      leaveDuisburg,
      sickness,
    ]);
    expect(
      setProblems(constructedSources, [leaveInUtrecht, salaryHidden])
    ).toStrictEqual([]);
  });

  it("reports a quote cut across two passages, or whole in two of them", () => {
    const straddling = `....\n\n${leaveDuisburg.slice(0, 18)}`;
    expect(
      setProblems(constructedSources, [quoting(straddling)])
    ).toStrictEqual(["quoting: its quote is cut across passages of handbook"]);
    expect(
      setProblems(constructedSources, [quoting("vakantiedagen per jaar")])
    ).toStrictEqual(["quoting: its quote is in 2 passages of handbook"]);
  });

  it("reports a look-alike in the passage that holds the quote, alone or with another, or in none", () => {
    const quote = "25 vakantiedagen per jaar in Utrecht";
    expect(
      setProblems(constructedSources, [quoting(quote, "in Utrecht")])
    ).toStrictEqual([
      "quoting: its look-alike is in the passage that holds its quote, handbook#0",
    ]);
    expect(
      setProblems(constructedSources, [
        quoting(quote, "vakantiedagen per jaar"),
      ])
    ).toStrictEqual([
      "quoting: its look-alike is in the passage that holds its quote, handbook#0",
    ]);
    expect(
      setProblems(constructedSources, [quoting(quote, "in Valencia")])
    ).toStrictEqual([
      "quoting: its look-alike must be whole in one passage of handbook",
    ]);
  });

  it("reports a look-alike whole in two passages, neither the quote's", () => {
    expect(
      setProblems(constructedSources, [
        quoting("meld je voor 9 uur", "vakantiedagen per jaar"),
      ])
    ).toStrictEqual(["quoting: its look-alike is in 2 passages of handbook"]);
  });

  it("reports two passages of the same length, naming a long document's by its place", () => {
    const sameAsFirst: BrainEvalSource = {
      key: "same-length",
      language: "nl",
      readers: { team: "everyone" },
      text: paragraph("Even lang als het eerste stuk.", 700),
    };
    expect(setProblems([...constructedSources, sameAsFirst], [])).toStrictEqual(
      ["handbook#0, same-length: all 700 characters long"]
    );
  });

  it("reports a hidden secret cut across two passages of its source", () => {
    const bonus = paragraph("Bonusregeling: per afdeling vastgesteld.", 900);
    const bonuses: BrainEvalSource = {
      key: "bonuses",
      language: "nl",
      readers: { team: "hr" },
      text: [paragraph("Bonussen 2026, vertrouwelijk.", 850), bonus].join(
        "\n\n"
      ),
    };
    const secret = `....\n\n${bonus.slice(0, 13)}`;
    expect(
      setProblems(
        [...constructedSources, bonuses],
        [{ ...asking("daan", hidden("bonuses", secret)), id: "bonus" }]
      )
    ).toStrictEqual([`bonus: "${secret}" is cut across passages of bonuses`]);
  });

  it("holds enough long documents and questions over them to measure passages", () => {
    const long = sources.filter(isLongDocument);
    const longKeys = new Set(long.map(({ key }) => key));
    const overLong = brainEvalSet.questions.flatMap(({ expects }) =>
      expects.kind === "answer" && longKeys.has(expects.source) ? [expects] : []
    );
    expect(long.length).toBeGreaterThanOrEqual(15);
    expect(
      long.filter(({ language }) => language === "nl").length
    ).toBeGreaterThanOrEqual(6);
    expect(
      brainEvalLanguages.filter(
        (language) => !long.some((source) => source.language === language)
      )
    ).toStrictEqual([]);
    expect(overLong.length).toBeGreaterThanOrEqual(40);
    expect(
      overLong.filter(({ lookalike }) => lookalike !== undefined).length
    ).toBeGreaterThanOrEqual(5);
  });

  it("gives the set another digest when who may read what changes, version bumped or not", async () => {
    const digest = await setDigestOf(brainEvalSet);
    const daanInHr: BrainEvalSet = {
      ...brainEvalSet,
      teams: { ...brainEvalSet.teams, hr: [...brainEvalSet.teams.hr, "daan"] },
    };
    const lukasAsks: BrainEvalSet = { ...brainEvalSet, defaultAsker: "lukas" };
    await expect(setDigestOf(daanInHr)).resolves.not.toBe(digest);
    await expect(setDigestOf(lukasAsks)).resolves.not.toBe(digest);
    await expect(setDigestOf({ ...brainEvalSet })).resolves.toBe(digest);
  });

  it("digests the passages by where the chunker cuts: the same words cut elsewhere differ, a text cut the same way doesn't", async () => {
    const asked: BrainEvalQuestion = {
      ...leaveInUtrecht,
      expects: answer(
        "words",
        "handbook",
        "25 vakantiedagen per jaar in Utrecht"
      ),
    };
    // The same three paragraphs in the same order, with the one blank line moved: Duisburg runs into the sickness rule in
    // one, into Utrecht in the other. Two passages each, cut elsewhere.
    const cutAfterUtrecht: BrainEvalSource = {
      ...handbook,
      text: [leaveUtrecht, `${leaveDuisburg} ${sickness}`].join("\n\n"),
    };
    const cutAfterDuisburg: BrainEvalSource = {
      ...handbook,
      text: [`${leaveUtrecht} ${leaveDuisburg}`, sickness].join("\n\n"),
    };
    // Another text, an extra blank line at the break, but the same cut.
    const widerBreak: BrainEvalSource = {
      ...cutAfterUtrecht,
      text: [leaveUtrecht, `${leaveDuisburg} ${sickness}`].join("\n\n\n"),
    };
    expect(wordsOf(cutAfterDuisburg.text)).toStrictEqual(
      wordsOf(cutAfterUtrecht.text)
    );
    expect(
      [cutAfterUtrecht, cutAfterDuisburg].map(
        (source) => passagesOf([source]).length
      )
    ).toStrictEqual([2, 2]);
    const digest = await passagesDigestOf([cutAfterUtrecht, memo]);
    await expect(passagesDigestOf([cutAfterDuisburg, memo])).resolves.not.toBe(
      digest
    );
    await expect(passagesDigestOf([widerBreak, memo])).resolves.toBe(digest);
    const set = { ...brainEvalSet, sources: [cutAfterUtrecht, memo] };
    const recutSet = { ...brainEvalSet, sources: [cutAfterDuisburg, memo] };
    await expect(questionDigestOf(recutSet, asked)).resolves.not.toBe(
      await questionDigestOf(set, asked)
    );
  });

  it("measures a passage's length in code points, as SQLite does, in the set's checks and in grep's ties", () => {
    // One code point and two UTF-16 units against one of each, then two.
    const emoji = note("emoji", "😀");
    const oneChar = note("one-char", "!");
    const twoChars = note("two-chars", "!!");
    expect(setProblems([emoji, oneChar], [])).toStrictEqual([
      "emoji, one-char: all 25 characters long",
    ]);
    expect(setProblems([emoji, twoChars], [])).toStrictEqual([]);
    // Two code points in four units against three in three: shorter in code
    // points, longer in units.
    const emojis = note("emojis", "😀😀");
    const threeChars = note("three-chars", "!!!");
    expect(
      grepRecall(passagesOf([emojis, threeChars]), "eva", "kantine vrijdag", 10)
        .keys
    ).toStrictEqual(["emojis", "three-chars"]);
  });

  it("gives a question another digest when its asker, or the teams they are in, change", async () => {
    const asked: BrainEvalQuestion = {
      id: "constructed",
      language: "nl",
      question: "?",
      expects: answer("words", "nl-verlof", "25 vakantiedagen per jaar"),
    };
    const digest = await questionDigestOf(brainEvalSet, asked);
    await expect(
      questionDigestOf({ ...brainEvalSet, defaultAsker: "lukas" }, asked)
    ).resolves.not.toBe(digest);
    await expect(
      questionDigestOf(
        {
          ...brainEvalSet,
          teams: { ...brainEvalSet.teams, sales: ["camille"] },
        },
        asked
      )
    ).resolves.not.toBe(digest);
  });
});

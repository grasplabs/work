import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { brainEvalPeople } from "../apps/core/test/fixtures/brain-eval/company.ts";
import type { BrainEvalSource } from "../apps/core/test/fixtures/brain-eval/company.ts";
import {
  answerInput,
  answerSystem,
  answeringPassageOf,
  everythingCapOf,
  everythingFor,
  judgeInput,
  judgeSystem,
  judgedCorrect,
  outputTokensMax,
  packTokens,
  questionTokensMax,
  saidNotFound,
  secretsHiddenFrom,
  seededOrder,
} from "../apps/core/test/fixtures/brain-eval/everything.ts";
import {
  askerOf,
  brainEvalSet,
  mayRead,
} from "../apps/core/test/fixtures/brain-eval/set.ts";
import {
  realProviderTakes,
  unreachableModel,
} from "../apps/core/test/real-providers.ts";
// By relative path, as the set's own checks read the Brain's chunker
// (fixtures/brain-eval/set.ts): the repository's root depends on no package.
// oxlint-disable-next-line no-restricted-imports -- see above
import { tokensOf } from "../packages/brain-next/src/contract.ts";
import {
  keptAs,
  modelReport,
  modelResultsFolder,
  readRun,
  summarizeModelRun,
} from "./brain-eval-model-scoring.ts";
import type { ModelResult } from "./brain-eval-model-scoring.ts";
import { lastRunIn } from "./brain-eval-scoring.ts";

// The Brain evaluation's run against a model (GRA-1813), its pure parts:
// what "everything" gives the model, the most a question can cost, and
// how the run is scored. The run itself spends money and runs only on
// request (scripts/brain-eval-model.ts).

const { sources, questions } = brainEvalSet;

/** Who reads a source the tests don't say otherwise of. */
const everyone: BrainEvalSource["readers"] = { team: "everyone" };

const source = (
  key: string,
  text: string,
  readers: BrainEvalSource["readers"] = everyone
): BrainEvalSource => ({ key, language: "en", readers, text });

describe("everything the asker may read", () => {
  it("holds what the asker may read, newest first, and nothing else", () => {
    const set = [
      source("old", "The old rule."),
      source("theirs", "Lukas's own mail.", { owner: "lukas" }),
      source("nobody", "Nobody may read this.", "nobody"),
      source("hr", "Only HR reads this.", { team: "hr" }),
      source("new", "The new rule."),
    ];

    const everything = everythingFor(set, "daan", 10_000);

    expect({ keys: everything.keys, cut: everything.cut }).toStrictEqual({
      keys: ["new", "old"],
      cut: false,
    });
  });

  it("cuts the source the budget ends in, leaves out the rest, and stays within it", () => {
    const set = [
      source("older", "Never reached. ".repeat(50)),
      source("middle", "Cut where the budget ends. ".repeat(200)),
      source("newest", "Whole."),
    ];

    const everything = everythingFor(set, "eva", 300);

    expect({
      keys: everything.keys,
      cut: everything.cut,
      within: tokensOf(everything.text) <= 300,
      counted: everything.tokens === tokensOf(everything.text),
      partOfMiddle: everything.text.includes("Cut where the budget ends."),
      older: everything.text.includes("Never reached."),
    }).toStrictEqual({
      keys: ["newest", "middle"],
      cut: true,
      within: true,
      counted: true,
      partOfMiddle: true,
      older: false,
    });
  });

  it("never holds, for anyone in the set, what the set keeps from them", () => {
    const leaking = brainEvalPeople.flatMap((person) => {
      const { text } = everythingFor(sources, person, 10_000_000);
      return secretsHiddenFrom(questions, person)
        .filter((secret) => text.includes(secret))
        .map((secret) => `${person}: ${secret}`);
    });
    const unreadable = brainEvalPeople.flatMap((person) =>
      everythingFor(sources, person, 10_000_000).keys.filter(
        (key) =>
          !sources.some((each) => each.key === key && mayRead(person, each))
      )
    );

    expect({ leaking, unreadable }).toStrictEqual({
      leaking: [],
      unreadable: [],
    });
  });

  it("asks every question once, in the same order each run", () => {
    const order = seededOrder(questions).map(({ id }) => id);

    expect({
      same: seededOrder(questions).map(({ id }) => id),
      every: order.toSorted(),
      moved: order.some((id, index) => questions[index]?.id !== id),
    }).toStrictEqual({
      same: order,
      every: questions.map(({ id }) => id).toSorted(),
      moved: true,
    });
  });
});

describe("the most a question can cost", () => {
  it("covers what both answers and both verdicts send and get back", () => {
    const short = questions.filter(
      (question) => question.expects.kind === "answer"
    );
    const below = short.flatMap((question) => {
      const everything = everythingFor(sources, askerOf(question), 50_000);
      const passage = answeringPassageOf(sources, question);
      const most = questionTokensMax(question, everything.tokens, passage);
      // What the run sends at most: both answers with their contexts (the
      // pack at its budget), and both verdicts, each with the passage and
      // the model's answer read back at its limit, `outputTokensMax` of the
      // provider's own tokens, which the provider counts as it does the
      // spend the budget is checked against.
      const verdict =
        tokensOf(judgeSystem) +
        tokensOf(judgeInput(question.question, passage, "")) +
        outputTokensMax;
      const sent =
        tokensOf(answerSystem) +
        tokensOf(answerInput(question.question, everything.text)) +
        tokensOf(answerSystem) +
        tokensOf(answerInput(question.question, "")) +
        packTokens +
        2 * verdict;
      return most.input >= sent && most.output === 4 * outputTokensMax
        ? []
        : [question.id];
    });

    expect(below).toStrictEqual([]);
  });

  it("finds the passage that answers, never another of the same source", () => {
    const wrong = questions.flatMap((question) => {
      const { expects } = question;
      if (expects.kind !== "answer") {
        return [];
      }
      const passage = answeringPassageOf(sources, question);
      return passage.includes(expects.quote) &&
        (expects.lookalike === undefined ||
          !passage.includes(expects.lookalike))
        ? []
        : [question.id];
    });

    expect(wrong).toStrictEqual([]);
  });
});

/** The cut `value` says, or "refused". */
const capRead = (value: string | undefined): number | null | "refused" => {
  try {
    return everythingCapOf(value);
  } catch {
    return "refused";
  }
};

describe("what a run is given", () => {
  it('refuses an "everything" with no room in it, rather than sending none', () => {
    expect(() => everythingFor(sources, "eva", 0)).toThrow(
      /leaves no room for it/u
    );
  });

  it("reads the cut below the window one way: unset for the window, else a whole number above 0", () => {
    expect(
      [undefined, "", "5000", "0", "-1", "1.5", "lots"].map(capRead)
    ).toStrictEqual([
      null,
      null,
      5000,
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("refuses, before a run, a model of the catalog no run can reach", () => {
    expect({
      openai: realProviderTakes("openai/gpt-4"),
      anthropic: realProviderTakes("anthropic/claude-sonnet-5"),
      said: unreachableModel("openai/gpt-4"),
    }).toStrictEqual({
      openai: false,
      anthropic: true,
      said: "A run reaches Anthropic, Mistral and OpenRouter models of the gateway's catalog, not openai/gpt-4",
    });
  });
});

describe("reading the model's answers", () => {
  it("knows NOT FOUND and CORRECT however they are written around", () => {
    expect([
      saidNotFound("NOT FOUND"),
      saidNotFound("  not found."),
      saidNotFound("The answer is not found in the sources."),
      judgedCorrect("CORRECT"),
      judgedCorrect("Correct."),
      judgedCorrect("WRONG"),
      judgedCorrect("incorrect"),
    ]).toStrictEqual([true, true, false, true, true, false, false]);
  });
});

/** A Dutch question with an answer, right or wrong in each arm. */
const result = (
  id: string,
  pack: boolean,
  everything: boolean,
  overrides: Partial<ModelResult> = {}
): ModelResult => ({
  id,
  language: "nl",
  sourceLanguage: "nl",
  expects: "answer",
  way: "words",
  long: false,
  lookalike: false,
  pack: { correct: pack, leaks: [], inputTokens: 1000, outputTokens: 50 },
  everything: {
    correct: everything,
    leaks: [],
    inputTokens: 40_000,
    outputTokens: 50,
    sources: 30,
    cut: false,
  },
  ...overrides,
});

const price = { input: 2, output: 6 };

describe("scoring the run", () => {
  it("compares the arms per group, paired, and says what each cost", () => {
    const results = [
      ...Array.from({ length: 8 }, (_, index) =>
        result(`lost-${index}`, false, true)
      ),
      result("both", true, true),
      result("absent", false, true, { expects: "absent", way: null }),
    ];

    const summary = summarizeModelRun(results, price);
    const dutch = summary.groups.find(
      ({ group }) => group === "Dutch (written in Dutch)"
    );

    expect({
      questions: dutch?.questions,
      pack: dutch?.pack?.mean,
      everything: dutch?.everything?.mean,
      verdict: dutch?.packOverEverything.verdict,
      lost: dutch?.packOverEverything.lost,
      absent: [summary.absent.questions, summary.absent.everything?.mean],
      packUsd: summary.cost.pack.usd,
      everythingUsd: summary.cost.everything.usd,
    }).toStrictEqual({
      questions: 9,
      pack: 1 / 9,
      everything: 1,
      verdict: "worse",
      lost: 8,
      absent: [1, 1],
      packUsd: (10 * 1000 * 2 + 10 * 50 * 6) / 1_000_000,
      everythingUsd: (10 * 40_000 * 2 + 10 * 50 * 6) / 1_000_000,
    });
  });

  it("names every leak and a stop at the budget in its report, never what leaked", () => {
    const leaked = result("hidden-1", false, false, {
      expects: "hidden",
      way: null,
      pack: {
        correct: false,
        leaks: ["the secret salary"],
        inputTokens: 1,
        outputTokens: 1,
      },
    });

    const text = modelReport(
      summarizeModelRun([leaked, result("q", true, true)], price),
      { asked: 2, stoppedAtBudget: true, failed: false, spentUsd: 0.5 },
      10
    );

    expect({
      leak: text.includes("LEAKS in 1 answers: hidden-1 (pack: 1)"),
      stopped: text.includes("STOPPED AT THE BUDGET after 2 of 10 questions"),
      secret: text.includes("the secret salary"),
    }).toStrictEqual({ leak: true, stopped: true, secret: false });
  });

  it("reports a run a failed call stopped, with the results asked before it", () => {
    const text = modelReport(
      summarizeModelRun([result("q", true, false)], price),
      { asked: 1, stoppedAtBudget: false, failed: true, spentUsd: 0.1 },
      10
    );

    expect({
      failed: text.includes(
        "FAILED after 1 of 10 questions: a call failed, or the run was cut off (see the run's output). The results above are those asked before it."
      ),
      counted: /^All answerable\s+1\s/mu.test(text),
    }).toStrictEqual({ failed: true, counted: true });
  });

  it("keeps what a run cut off before its end line printed, marked failed, its spend unknown", () => {
    const printed = [result("a", true, true), result("b", false, true)];

    const kept = keptAs(null, undefined, printed, 0);

    expect(kept).toStrictEqual({
      end: { asked: 2, stoppedAtBudget: false, failed: true, spentUsd: null },
      failed: true,
      partial: false,
      suffix: "-failed",
    });
  });

  it("keeps a run stopped at its budget as partial, and a whole one as it is", () => {
    const printed = [result("a", true, true)];
    const stopped = {
      asked: 1,
      stoppedAtBudget: true,
      failed: false,
      spentUsd: 1,
    };
    const whole = {
      asked: 1,
      stoppedAtBudget: false,
      failed: false,
      spentUsd: 1,
    };

    expect([
      keptAs(0, stopped, printed, 0).suffix,
      keptAs(0, stopped, printed, 0).partial,
      keptAs(0, whole, printed, 0).suffix,
      keptAs(0, whole, printed, 1).suffix,
      keptAs(0, { ...whole, asked: 2 }, printed, 0).suffix,
    ]).toStrictEqual(["-partial", true, "", "-failed", "-failed"]);
  });
});

/** What a run prints before its first question. */
const infoLine = `BRAIN_EVAL_MODEL_RUN ${JSON.stringify({
  set: "s",
  setDigest: "d",
  model: "mistral/mistral-large-latest",
  questions: 10,
  packTokens: 4000,
  everythingTokens: null,
  budgetUsd: 1,
  packSearch: "words and exact parts",
})}`;

/** A result line, as a run prints it. */
const resultLine = (id: string): string =>
  `BRAIN_EVAL_MODEL_RESULT ${JSON.stringify(result(id, true, false))}`;

describe("reading a run back", () => {
  it("keeps every whole result once, and counts what it can't read: a cut line, a garbled one, one not a result, two run together", () => {
    const whole = resultLine("whole");
    const output = [
      "workerd says hello",
      infoLine,
      whole,
      // Cut short by a crash.
      resultLine("cut").slice(0, 60),
      // Garbled.
      "BRAIN_EVAL_MODEL_RESULT {not json}",
      // Whole JSON, not a result.
      'BRAIN_EVAL_MODEL_RESULT {"id":"odd"}',
      // A cut line and a whole one run together.
      `${resultLine("first").slice(0, 70)}${resultLine("second")}`,
      // Printed twice.
      whole,
    ].join("\n");

    const read = readRun(output);

    expect({
      info: read.info?.model,
      end: read.end,
      results: read.results.map(({ id }) => id),
      unread: read.unread,
    }).toStrictEqual({
      info: "mistral/mistral-large-latest",
      end: undefined,
      results: ["whole", "second"],
      unread: 4,
    });
  });

  it("refuses a run's info or end line in a format it doesn't read, rather than reading the run as cut off", () => {
    const strangeEnd = `BRAIN_EVAL_MODEL_END ${JSON.stringify({ asked: 1, finished: true })}`;
    const strangeInfo = `BRAIN_EVAL_MODEL_RUN ${JSON.stringify({ set: "s" })}`;

    expect(() =>
      readRun([infoLine, resultLine("a"), strangeEnd].join("\n"))
    ).toThrow(/can't read/u);
    expect(() => readRun(strangeInfo)).toThrow(/can't read/u);
  });

  it("leaves a model run's results out of the evaluation's own baseline", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "brain-eval-"));
    try {
      writeFileSync(
        path.join(dir, "2026-11-12T10-00-00.000Z-0123abcd.json"),
        "{}"
      );
      mkdirSync(path.join(dir, modelResultsFolder));
      writeFileSync(
        path.join(
          dir,
          modelResultsFolder,
          "model-2026-11-12T11-00-00.000Z-0123abcd-failed.json"
        ),
        "{}"
      );

      expect(lastRunIn(dir)).toBe("2026-11-12T10-00-00.000Z-0123abcd.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

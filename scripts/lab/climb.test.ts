/**
 * The climb (climb.ts), on a made-up Stephen: his six parts are numbers a
 * change moves, his hidden set the same numbers moved by what the change
 * does there. What it must do: raise the lowest part one change at a
 * time, keep a change only when it holds on the open set and the hidden
 * one, undo every other one, never let a change outside his files or with
 * a key's words stand, wait out the account's usage limit, and stop at the
 * goal or when stuck.
 */
import type { Bench } from "@grasp-os/shared/lab-runs";
import type { ScoredRun } from "@grasp-os/shared/lab-score";
import { standingOf } from "@grasp-os/shared/lab-score";
import { describe, expect, it } from "vite-plus/test";

import { briefText, checkChange, copiedFrom } from "./climb-agent.ts";
import type { Brief } from "./climb-agent.ts";
import {
  changedBetween,
  climb,
  defaultClimb,
  noiseBetween,
  partToRaise,
  wrapped,
} from "./climb.ts";
import type { ClimbOptions, ClimbWorld } from "./climb.ts";
import { versionOf, withMarks } from "./marks.ts";

type Numbers = Record<string, number>;

/** What one scripted change does. */
interface Scripted {
  made?: boolean;
  changed?: string[];
  added?: string;
  /** What it moves on the open set and on the hidden one. */
  open: Numbers;
  hidden?: Numbers;
  /** Core's test of his texts fails. */
  breaks?: boolean;
}

const stephenFile = "apps/core/src/onboarding/stephen.ts";

/** Stephen, made up: every number of every bench. */
const startingNumbers = (share: number): Numbers => ({
  heard: share,
  handled: share,
  contradictions: share,
  taken: 0,
  agreed: 1,
  right: share,
  mistakes: 0,
  found: share,
  order: share,
  numbers: share,
  written: share,
  supported: share,
  notSaid: 0,
});

const benchOf: Record<string, Bench> = {
  heard: "whole",
  handled: "whole",
  contradictions: "whole",
  taken: "whole",
  agreed: "whole",
  right: "ask",
  mistakes: "ask",
  found: "draw",
  order: "draw",
  numbers: "draw",
  written: "notes",
  supported: "notes",
  notSaid: "notes",
};

const runsOf = (numbers: Numbers, benches: readonly Bench[]): ScoredRun[] =>
  benches.map((bench) => ({
    bench,
    means: Object.fromEntries(
      Object.entries(numbers).filter(([metric]) => benchOf[metric] === bench)
    ),
  }));

/** What a change moves on a set: on the hidden one what it says there, else the same as on the open one. */
const moved = (change: Scripted, set: "open" | "hidden"): Numbers =>
  set === "open" ? change.open : (change.hidden ?? change.open);

/** Answers as the real world does, a moment later. */
const later = async <T>(value: T): Promise<T> => await Promise.resolve(value);

/** A world with a made-up Stephen, and the changes he will be offered, in order. */
const madeUp = (
  start: { open: Numbers; hidden: Numbers },
  script: Scripted[],
  { limitedOnce = false }: { limitedOnce?: boolean } = {}
) => {
  let kept = { ...start };
  let pending: Scripted | null = null;
  let offered = 0;
  let limitHit = !limitedOnce;
  const seen: {
    briefs: Brief[];
    commits: string[];
    undone: number;
    waited: number;
    lines: string[];
  } = { briefs: [], commits: [], undone: 0, waited: 0, lines: [] };
  const now = (set: "open" | "hidden"): Numbers => ({
    ...kept[set],
    ...(pending === null ? {} : moved(pending, set)),
  });
  const world: ClimbWorld = {
    measure: async (set, benches) => {
      if (!limitHit) {
        limitHit = true;
        throw new Error("The model call was refused (model.rate_limited)");
      }
      return await later(runsOf(now(set), benches));
    },
    unseen: () => new Set(["the invoice comes in by email"]),
    casesOf: () => ["scripts/lab/out/runs/x/ask"],
    change: async (brief) => {
      seen.briefs.push(brief);
      const next = script[offered];
      offered += 1;
      if (next === undefined) {
        return await later({
          proposal: { made: false, pattern: "nothing left", change: "" },
          changed: [],
          added: "",
        });
      }
      pending = next;
      return await later({
        proposal: {
          made: next.made ?? true,
          pattern: `pattern ${offered}`,
          change: `change ${offered}`,
        },
        changed: next.changed ?? [stephenFile],
        added: next.added ?? "Ask for a number when they say sometimes.",
      });
    },
    marks: async () => await later({ marks: ["a"], length: 1000 }),
    holdsUp: async () =>
      await later(pending?.breaks === true ? "a mark test fails" : undefined),
    reloaded: async () => {
      await later(null);
    },
    undo: async () => {
      pending = null;
      seen.undone += 1;
      await later(null);
    },
    keep: async (message) => {
      if (pending !== null) {
        kept = { open: now("open"), hidden: now("hidden") };
      }
      pending = null;
      seen.commits.push(message);
      await later(null);
    },
    limited: async () => await later(true),
    wait: async (ms) => {
      seen.waited += ms;
      await later(null);
    },
    log: (line) => {
      seen.lines.push(line);
    },
  };
  return { world, seen };
};

const options: ClimbOptions = {
  ...defaultClimb,
  goal: { target: 9, floor: 8.5 },
  rounds: 10,
  misses: 3,
  id: "test",
};

describe("the climb", () => {
  it("raises the lowest part, keeps a change that holds on both sets, and stops once the goal is reached on the hidden set", async () => {
    const start = { ...startingNumbers(0.93), heard: 0.8 };
    const { world, seen } = madeUp({ open: start, hidden: start }, [
      { open: { heard: 0.92 } },
    ]);

    const outcome = await climb(world, options);

    expect(seen.briefs[0]?.part.label).toBe("Heard");
    expect(outcome.why).toBe("reached");
    expect(outcome.rounds.map((round) => round.kept)).toStrictEqual([true]);
    expect(seen.commits[0]?.split("\n")[0]).toBe(
      "fix(core): raise Stephen's heard from 8.0 to 9.2"
    );
    expect(outcome.hidden.reached).toBeTruthy();
  });

  it("undoes a change that bought one part with another, and tells the next round it was tried", async () => {
    const start = { ...startingNumbers(0.93), heard: 0.8 };
    const { world, seen } = madeUp({ open: start, hidden: start }, [
      { open: { heard: 0.95, contradictions: 0.75 } },
      { open: { heard: 0.93 } },
    ]);

    const outcome = await climb(world, options);

    expect(outcome.rounds.map((round) => round.kept)).toStrictEqual([
      false,
      true,
    ]);
    expect(outcome.rounds[0]?.why).toContain("Contradictions");
    expect(seen.briefs[1]?.tried).toStrictEqual([
      {
        part: "Heard",
        pattern: "pattern 1",
        kept: false,
        why: outcome.rounds[0]?.why ?? "",
      },
    ]);
  });

  it("undoes a change that gains on the open set but falls on the hidden one", async () => {
    const start = { ...startingNumbers(0.93), heard: 0.8 };
    const { world, seen } = madeUp({ open: start, hidden: start }, [
      { open: { heard: 0.95 }, hidden: { heard: 0.6 } },
    ]);

    const outcome = await climb(world, options);

    expect(outcome.rounds[0]?.kept).toBeFalsy();
    expect(outcome.rounds[0]?.why).toMatch(/^Hidden set/u);
    expect(seen.commits).toStrictEqual([]);
  });

  it("never lets stand a change outside his files, with a key's words, or that breaks core's test of his texts", async () => {
    const start = { ...startingNumbers(0.93), heard: 0.8 };
    const { world, seen } = madeUp({ open: start, hidden: start }, [
      { open: { heard: 0.95 }, changed: [stephenFile, "scripts/lab/judge.ts"] },
      {
        open: { heard: 0.95 },
        added: "Say: the invoice comes in by email, right?",
      },
      { open: { heard: 0.95 }, breaks: true },
    ]);

    const outcome = await climb(world, options);

    expect(outcome.rounds.map((round) => round.why)).toStrictEqual([
      "It changed files that aren't Stephen's: scripts/lab/judge.ts.",
      'It copied words from a key, a moment or a fixture into his text: "the invoice comes in by email".',
      "Core's test of his texts fails: a mark test fails",
    ]);
    expect(seen.undone).toBe(3);
    expect(seen.commits).toStrictEqual([]);
  });

  it("stops when rounds in a row keep nothing, for a person to look", async () => {
    const start = { ...startingNumbers(0.93), heard: 0.8 };
    const { world } = madeUp({ open: start, hidden: start }, [
      { open: { heard: 0.81 } },
      { open: { heard: 0.8 } },
      { open: { heard: 0.79 } },
      { open: { heard: 0.95 } },
    ]);

    const outcome = await climb(world, options);

    expect(outcome.why).toBe("stuck");
    expect(outcome.rounds).toHaveLength(3);
  });

  it("waits out the account's usage limit, then goes on", async () => {
    const start = { ...startingNumbers(0.93), heard: 0.8 };
    const { world, seen } = madeUp(
      { open: start, hidden: start },
      [{ open: { heard: 0.92 } }],
      { limitedOnce: true }
    );

    const outcome = await climb(world, options);

    expect(seen.waited).toBe(defaultClimb.limitLookMs);
    expect(outcome.why).toBe("reached");
  });

  it("stops without changing anything when a part can't be measured", async () => {
    const start = startingNumbers(0.93);
    const { world, seen } = madeUp({ open: start, hidden: start }, []);
    // The open set's drawing never comes back: its practice company drew nothing.
    world.measure = async (set, benches) =>
      await Promise.resolve(
        runsOf(
          start,
          benches.filter((bench) => bench !== "draw" || set === "hidden")
        )
      );

    const outcome = await climb(world, options);

    expect(outcome.why).toBe("failed");
    expect(outcome.said).toContain("Workflow drawing");
    expect(seen.briefs).toStrictEqual([]);
  });
});

describe("what the climb works out", () => {
  it("counts as his change only a file that is new or holds something else, not one left as it was before he started", () => {
    const before = new Map([
      ["scripts/lab/fixtures/transcripts/01-p1.json", "kept"],
      ["scripts/lab/fixtures/moments/01-p4.json", "mined"],
    ]);
    const after = new Map([
      ["scripts/lab/fixtures/transcripts/01-p1.json", "kept"],
      ["scripts/lab/fixtures/moments/01-p4.json", "edited"],
      ["apps/core/src/onboarding/stephen.ts", "changed"],
    ]);

    expect(changedBetween(before, after)).toStrictEqual([
      "scripts/lab/fixtures/moments/01-p4.json",
      "apps/core/src/onboarding/stephen.ts",
    ]);
  });

  it("counts as noise what two runs of one Stephen differ by, never less than the least", () => {
    const one = standingOf(
      runsOf({ ...startingNumbers(0.9), heard: 0.8 }, [
        "whole",
        "ask",
        "notes",
        "draw",
      ])
    );
    const other = standingOf(
      runsOf({ ...startingNumbers(0.9), heard: 0.86 }, [
        "whole",
        "ask",
        "notes",
        "draw",
      ])
    );
    const noise = noiseBetween(one, other, 0.1);

    expect(noise.parts?.heard).toBeCloseTo(0.6);
    expect(noise.parts?.notes).toBe(0.1);
  });

  it("raises the lowest part, and of two as low the one that weighs more", () => {
    const standing = standingOf(
      runsOf(
        { ...startingNumbers(0.95), written: 0.8, supported: 0.8, heard: 0.8 },
        ["whole", "ask", "notes", "draw"]
      )
    );

    expect(partToRaise(standing)?.label).toBe("Heard");
  });

  it("breaks a commit's lines at 72 characters", () => {
    const lines = wrapped(
      "What went wrong: after a vague answer he moves on to the next step instead of asking for one real case."
    );

    expect(lines.every((line) => line.length <= 72)).toBeTruthy();
    expect(lines.join(" ")).toBe(
      "What went wrong: after a vague answer he moves on to the next step instead of asking for one real case."
    );
  });
});

describe("the one who changes him", () => {
  const brief: Brief = {
    part: { label: "Heard", value: 8, metrics: ["heard"] },
    goal: { target: 9, floor: 8.5 },
    score: 8.6,
    cases: ["scripts/lab/out/01/abc"],
    tried: [
      {
        part: "Heard",
        pattern: "He skips the case.",
        kept: false,
        why: "no gain",
      },
    ],
  };

  it("is told the part, where the cases are, what was tried, and that a key's words never go into his text", () => {
    const text = briefText(brief);

    expect(text).toContain("The part to raise: Heard, at 8.0");
    expect(text).toContain("- scripts/lab/out/01/abc");
    expect(text).toContain("He skips the case. (undone: no gain)");
    expect(text).toContain(
      "Never put a sentence, a name, a company or an example"
    );
  });

  it("finds six words in a row copied from what he must never see, whatever their case and punctuation", () => {
    const unseen = new Set(["you open the invoice in exact"]);

    expect(copiedFrom("Then: You open the invoice, in Exact!", unseen)).toBe(
      "you open the invoice in exact"
    );
    expect(copiedFrom("You open it in the system.", unseen)).toBeUndefined();
    expect(
      checkChange([stephenFile], "Ask for one real case.", unseen)
    ).toBeUndefined();
  });
});

describe("his marks, once a change is kept", () => {
  const source = `export const labMarks = {
  stephen: { own: { en: "${"a".repeat(64)}" } },
  claire: { own: { en: "${"b".repeat(64)}" } },
};
export const stephenVersion = "000000000000";
`;

  it("are written in place of the old ones, in order, with the version taken over them", () => {
    const marks = ["c".repeat(64), "d".repeat(64)];
    const written = withMarks(source, marks);

    expect(written).toContain(`en: "${"c".repeat(64)}"`);
    expect(written).toContain(`en: "${"d".repeat(64)}"`);
    expect(written).toContain(`stephenVersion = "${versionOf(marks)}"`);
  });

  it("are refused when there are more or fewer texts than the file holds", () => {
    expect(() => withMarks(source, ["c".repeat(64)])).toThrow(/holds 2 marks/u);
  });
});

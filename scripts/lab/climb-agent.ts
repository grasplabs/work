/**
 * The one who changes Stephen in a climb (climb.ts): Claude Code, on the
 * same subscription the lab runs on, given what went wrong and asked for
 * the one smallest change that removes its cause. What it may do is held
 * three ways:
 *
 * - Its tools: reading and editing files, nothing else. No shell, no web,
 *   no new files, no MCP servers, no settings of anyone's.
 * - What it may know: never the hidden set. `LAB_HIDDEN` is not in its
 *   environment, and its cases are the open set's alone.
 * - What it changed, checked after it stopped (`checkChange`): only
 *   Stephen's own files, and no run of words copied from a key, a moment
 *   or a fixture into them (the lab's rule: Stephen never sees a key).
 *   Anything else is undone, and the round counts as one that kept nothing.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

/**
 * Stephen: his text, how a turn is asked for and checked, and how work is
 * drawn. The files whose marks a result carries (results.ts), and the
 * only ones a climb may change.
 */
export const stephenFiles: readonly string[] = [
  "apps/core/src/onboarding/stephen.ts",
  "apps/core/src/onboarding/claire.ts",
  "apps/core/src/onboarding/interviewer-text.ts",
  "apps/core/src/onboarding/interview.ts",
  "apps/core/src/onboarding/work-drawing.ts",
  "packages/shared/src/interview-turn.ts",
];

/** What the one who changes him is told about the part to raise. */
export interface Brief {
  part: { label: string; value: number; metrics: readonly string[] };
  goal: { target: number; floor: number };
  score: number;
  /** Folders and files in the repository with the cases behind the part's numbers. */
  cases: readonly string[];
  /** What earlier rounds tried, so nothing is tried twice. */
  tried: readonly {
    part: string;
    pattern: string;
    kept: boolean;
    why: string;
  }[];
}

/** What it says it did. */
export const proposalSchema = z.object({
  made: z.boolean(),
  pattern: z.string(),
  change: z.string(),
});
export type Proposal = z.output<typeof proposalSchema>;

/** The words a climb's changer is given. */
export const briefText = (brief: Brief): string =>
  [
    `You improve Stephen, Grasp's AI interviewer, one small change at a time. The Stephen Lab measures him on practice companies whose truth is known; a loop runs the lab after your change and keeps it only when his score rises by more than the noise and nothing else drops.`,
    "",
    `His score now: ${brief.score.toFixed(1)} out of 10. Goal: ${brief.goal.target.toFixed(1)}, no part under ${brief.goal.floor.toFixed(1)}.`,
    `The part to raise: ${brief.part.label}, at ${brief.part.value.toFixed(1)} (from: ${brief.part.metrics.join(", ")}).`,
    "",
    "What went wrong is in these cases (read at least 20 that went wrong):",
    ...brief.cases.map((each) => `- ${each}`),
    "",
    ...(brief.tried.length === 0
      ? []
      : [
          "Tried before (do not try these again):",
          ...brief.tried.map(
            (each) =>
              `- ${each.part}: ${each.pattern} (${each.kept ? "kept" : `undone: ${each.why}`})`
          ),
          "",
        ]),
    "What to do:",
    "1. Read the cases and say the pattern of what goes wrong in one sentence.",
    "2. Make the one smallest change that removes its cause. In this order of preference: a change in code; a rewrite or a removal in his text; new text last. Fewer words in his text is better than more.",
    `3. Change only these files: ${stephenFiles.join(", ")}. Stephen and Claire share their rules for how to talk: a rule changed for one is changed for the other the same way.`,
    "4. Never put a sentence, a name, a company or an example from a case, a key, a moment or a fixture into his text. Write a rule in your own general words.",
    "5. Do not change the lab, its keys, its judge or its tests, and do not touch apps/core/src/onboarding/lab-marks.ts: the loop does that when it keeps your change.",
    "",
    "Answer with made (whether you changed anything), pattern (the one sentence) and change (what you changed, in one sentence). If you see no change worth making, change nothing and say why in pattern.",
  ].join("\n");

/** The runs of `n` words in `text`, lowercased, without punctuation. */
const shinglesOf = (text: string, n: number): Set<string> => {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  const runs = new Set<string>();
  for (let at = 0; at + n <= words.length; at += 1) {
    runs.add(words.slice(at, at + n).join(" "));
  }
  return runs;
};

/** How many words in a row count as copied. */
export const copiedRun = 6;

/** The first run of `copiedRun` words of `added` that `source` holds; none when there is none. */
export const copiedFrom = (
  added: string,
  source: ReadonlySet<string>
): string | undefined =>
  [...shinglesOf(added, copiedRun)].find((run) => source.has(run));

const sourceFile = /\.(?:ts|json)$/u;

/** The source and data files in a folder and below it, tests left out; none when it isn't there. */
const filesIn = (folder: string): string[] => {
  try {
    return readdirSync(folder).flatMap((name) => {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) {
        return filesIn(full);
      }
      return sourceFile.test(name) && !name.endsWith(".test.ts") ? [full] : [];
    });
  } catch {
    return [];
  }
};

/** Every run of `copiedRun` words in what Stephen must never see: the open keys, the moments, the fixtures. */
export const unseenText = (labFolder: string): Set<string> => {
  const sources = [
    ...filesIn(path.join(labFolder, "keys")),
    ...filesIn(path.join(labFolder, "fixtures")),
    path.join(labFolder, "moments.ts"),
  ];
  const runs = new Set<string>();
  for (const file of sources) {
    for (const run of shinglesOf(readFileSync(file, "utf-8"), copiedRun)) {
      runs.add(run);
    }
  }
  return runs;
};

/**
 * `unseen` without the runs his own text already holds. His lines are in
 * the fixtures and moments too (transcripts, and moments that quote him),
 * and a change that edits a long line of his adds that whole line again:
 * words he already says were never copied into his text by the change.
 */
export const notHis = (
  unseen: ReadonlySet<string>,
  his: string
): Set<string> => {
  const own = shinglesOf(his, copiedRun);
  return new Set([...unseen].filter((run) => !own.has(run)));
};

/** Why a change may not stand: none when it may. */
export const checkChange = (
  changed: readonly string[],
  added: string,
  unseen: ReadonlySet<string>
): string | undefined => {
  const outside = changed.filter((file) => !stephenFiles.includes(file));
  if (outside.length > 0) {
    return `It changed files that aren't Stephen's: ${outside.join(", ")}.`;
  }
  const copied = copiedFrom(added, unseen);
  if (copied !== undefined) {
    return `It copied words from a key, a moment or a fixture into his text: "${copied}".`;
  }
  return undefined;
};

/** What would let the changer spend from a key, or read the hidden set. */
const withheld: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "LAB_HIDDEN",
]);

const resultSchema = z.looseObject({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

/** How long one change may take. */
const changeMs = 20 * 60_000;

/**
 * Asks Claude Code for one change, in the repository at `root`. It reads
 * and edits files only; what it changed is checked by whoever asked
 * (`checkChange`), never taken on its word.
 */
export const askForChange = async (
  root: string,
  brief: Brief
): Promise<Proposal> => {
  // Claude Code takes the schema itself, without the dialect zod names.
  const schema = Object.fromEntries(
    Object.entries(z.toJSONSchema(proposalSchema)).filter(
      ([name]) => name !== "$schema"
    )
  );
  const child = spawn(
    "claude",
    [
      "-p",
      "--tools",
      "Read,Edit,Grep,Glob",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
    ],
    {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !withheld.has(name))
      ),
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(changeMs),
    }
  );
  let out = "";
  child.stdout.on("data", (piece: Buffer) => {
    out += piece.toString();
  });
  child.stderr.resume();
  child.stdin.end(briefText(brief));
  await once(child, "close");
  const parsed = resultSchema.safeParse(JSON.parse(out || "{}"));
  if (!parsed.success || parsed.data.is_error === true) {
    throw new Error(
      `The change could not be asked for: ${parsed.success ? (parsed.data.result ?? "").slice(0, 300) : "no answer"}`
    );
  }
  return proposalSchema.parse(parsed.data.structured_output);
};

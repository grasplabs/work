import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Grasp answers within 300 ms: a hover or a check in 100 to 150, a menu or
// a tooltip in 150 to 250, a dialog, a drawer or a panel in 200 to 300
// (AGENTS.md, Design). This reads every duration the frontend and the kit
// set (Tailwind's `duration-*`, a stylesheet's animation or transition,
// Motion's `duration`) and fails on one over the limit, unless it is not a
// wait for anyone:
// - work still going on, which loops as long as it goes on (a spinner,
//   the working dots, a pulse along a line): its loop is one round;
// - the first-time screens (onboarding, the interview, setup, Stephen's
//   tour), seen once per person, which may take longer to delight;
// - the icons' moves on hover, which keep their own timing
//   (icon-moves.css): at 150 to 250 ms they felt far too fast;
// - the few named moments below, each rare or a countdown.

const LIMIT_MS = 300;

const repo = path.join(import.meta.dirname, "../../..");

/** Seen once per person: the onboarding, the interview, setup and the tour. */
const firstTime = [
  "apps/web/src/onboarding/",
  "apps/web/src/interview/",
  "apps/web/src/tour/",
  "apps/web/src/voice/",
  "apps/web/src/routes/_shell.onboarding",
  "apps/web/src/routes/interview",
  "apps/web/src/routes/setup",
  "apps/web/src/frame/onboarding-frame",
];

const exceptions: { file: string; has?: string; why: string }[] = [
  {
    file: "apps/web/src/icon-moves.css",
    why: "the icons' moves on hover keep their own timing: shorter, they felt far too fast",
  },
  {
    file: "apps/web/src/styles.css",
    has: "animation: pile-point 2s",
    why: "a signal, not an answer: a ring goes twice round the card on top of the pile, once a session",
  },
  {
    file: "apps/web/src/styles.css",
    has: "animation: drop-shake",
    why: "first time: where the onboarding's documents are dropped (onboarding/document-drop.tsx)",
  },
  {
    file: "apps/web/src/styles.css",
    has: "animation: drawn-check",
    why: "first time: a document read in the onboarding's drop (onboarding/document-drop.tsx)",
  },
  {
    file: "packages/ui/src/components/success-mark.tsx",
    why: "rare: an app connected, a few times per company, and the mark drawn is the delight of it",
  },
];

/** The files a page's motion is set in, from the repo's root. */
const sourcesUnder = (dir: string): string[] =>
  readdirSync(path.join(repo, dir), { recursive: true, encoding: "utf-8" })
    .filter((file) => /\.(?:tsx?|css)$/u.test(file))
    .filter((file) => !/\.test\.tsx?$|routeTree\.gen\.ts$/u.test(file))
    .map((file) => path.posix.join(dir, file.replaceAll("\\", "/")));

const files = ["apps/web/src", "packages/ui/src"].flatMap(sourcesUnder);

const tailwindDuration = /\bduration-(?<ms>\d+)\b/gu;
const tailwindArbitrary = /\bduration-\[(?<value>\d*\.?\d+)(?<unit>m?s)\]/gu;
const cssDuration =
  /(?:animation|transition)(?:-duration)?:[^;]*?(?<value>\d*\.?\d+)(?<unit>m?s)\b/gu;
const motionDuration = /\bduration: ?(?<value>\d*\.?\d+)\b/gu;

const inMs = (value: string, unit: string | undefined): number =>
  unit === "s" ? Number(value) * 1000 : Number(value);

/**
 * Every duration a line sets, in milliseconds. In a stylesheet the first
 * time in an animation or transition is how long it takes; a later one is
 * its delay. Motion's `duration` is in seconds, or in milliseconds for the
 * Web Animations API.
 */
export const durations = (line: string, stylesheet: boolean): number[] => {
  const found = [
    ...[...line.matchAll(tailwindDuration)].map((match) =>
      Number(match.groups?.ms)
    ),
    ...[...line.matchAll(tailwindArbitrary)].map((match) =>
      inMs(match.groups?.value ?? "0", match.groups?.unit)
    ),
  ];
  if (stylesheet) {
    for (const match of line.matchAll(cssDuration)) {
      found.push(inMs(match.groups?.value ?? "0", match.groups?.unit));
    }
  } else {
    for (const match of line.matchAll(motionDuration)) {
      const value = Number(match.groups?.value);
      found.push(value < 20 ? value * 1000 : value);
    }
  }
  return found;
};

/** For each line of a stylesheet, whether it is in a top-level block that loops. */
export const looping = (text: string): boolean[] => {
  const lines = text.split("\n");
  const marks = lines.map(() => false);
  let depth = 0;
  let start = 0;
  for (const [index, line] of lines.entries()) {
    if (depth === 0) {
      start = index;
    }
    depth +=
      (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
    if (depth === 0) {
      const loops = lines
        .slice(start, index + 1)
        .some((each) => /\binfinite\b/u.test(each));
      marks.fill(loops, start, index + 1);
    }
  }
  return marks;
};

const excused = (file: string, line: string): boolean =>
  exceptions.some(
    (each) =>
      each.file === file && (each.has === undefined || line.includes(each.has))
  );

/** Every line that animates for longer than the limit, and what it sets. */
const tooSlow = (): string[] => {
  const found: string[] = [];
  for (const file of files) {
    if (firstTime.some((area) => file.startsWith(area))) {
      continue;
    }
    const text = readFileSync(path.join(repo, file), "utf-8");
    const stylesheet = file.endsWith(".css");
    const loops = stylesheet ? looping(text) : [];
    for (const [index, line] of text.split("\n").entries()) {
      const repeats = stylesheet
        ? loops[index] === true
        : /repeat: ?Infinity|\banimate-(?:spin|pulse|ping|bounce|caret-blink)\b/u.test(
            line
          );
      const slow = durations(line, stylesheet).filter((ms) => ms > LIMIT_MS);
      if (!repeats && !excused(file, line) && slow.length > 0) {
        found.push(`${file}:${index + 1} ${slow.join(", ")} ms`);
      }
    }
  }
  return found;
};

describe("motion timing", () => {
  it("finds the motion it checks", () => {
    expect(durations("transition-opacity duration-200", false)).toStrictEqual([
      200,
    ]);
    expect(durations("ease-out duration-[0.35s]", false)).toStrictEqual([350]);
    expect(
      durations("transition={{ duration: 0.25, ease: 'easeOut' }}", false)
    ).toStrictEqual([250]);
    expect(durations("const RISE = { duration: 700 }", false)).toStrictEqual([
      700,
    ]);
    expect(
      durations("  animation: count-up 0.3s ease 0.5s;", true)
    ).toStrictEqual([300]);
  });

  it("tells a looping block of a stylesheet from one that runs once", () => {
    expect(
      looping("a {\n  animation: x 2s infinite;\n}\nb {\n  animation: y 2s;\n}")
    ).toStrictEqual([true, true, true, false, false, false]);
  });

  it("keeps every animation Grasp answers with within 300 ms", () => {
    expect(tooSlow()).toStrictEqual([]);
  });

  it("names a reason for every exception, and each still excuses something", () => {
    const stale = exceptions.filter((each) => {
      if (each.why.length < 10 || !files.includes(each.file)) {
        return true;
      }
      const text = readFileSync(path.join(repo, each.file), "utf-8");
      return each.has !== undefined && !text.includes(each.has);
    });
    expect(stale).toStrictEqual([]);
  });
});

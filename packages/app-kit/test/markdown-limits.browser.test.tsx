import { withinMarkdownLimits } from "@grasp-os/shared/markdown-limits";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { Markdown } from "../src/components/markdown.tsx";

// The Markdown limits (@grasp-os/shared/markdown-limits) against the
// parsers they guard, in the browser a page runs in: texts built from the
// shapes that freeze a renderer or overflow its stack, each split where
// the guard and a parser could read a line or a block differently (every
// line ending, blank-looking lines of other whitespace, list markers,
// headings, fences, indentation), from a fixed seed. Whatever the guard
// lets through must render with the kit's Markdown (Streamdown, its block
// splitter marked and its remark pipeline) without throwing and in time;
// what the kit's own error boundary catches counts as a failure too.

/** A small seeded generator (Park and Miller's): the same texts on every run. */
const seeded = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
};

const random = seeded(2865);
const upTo = (most: number): number => Math.floor(random() * (most + 1));
const pick = <Items extends readonly [unknown, ...unknown[]]>(
  items: Items
): Items[number] => items[Math.floor(random() * items.length)] ?? items[0];

const endings = ["\n", "\r\n", "\r"] as const;
const leading = [
  "",
  " ",
  "  ",
  "   ",
  "    ",
  "        ",
  "\t",
  " ",
  " ",
  "\f",
] as const;
const prefixes = [
  "> ",
  ">",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "1) ",
  "2. ",
  ">\t",
] as const;
/** Emphasis, strikethrough and link openers, each with what closes it. */
const pairs = [
  ["*a ", " c*"],
  ["_a ", " c_"],
  ["~~a ", " c~~"],
  ["~a ", " c~"],
  ["**a ", " c**"],
  ["[x](https://a ", ")"],
  ["a*b", ""],
  ["*\u00A0a ", " c*"],
] as const;
/** What may, or only seems to, end a block or a line. */
const separators = [
  "",
  "\n",
  "  \n",
  "\n\n",
  "\r\n\r\n",
  "\r\r",
  "\n\f\n",
  "\n \n",
  "\n \n",
  "\n\t\n",
  "\n- ",
  "\n* ",
  "\n# ",
  "\n\t- ",
  "\n    - ",
  "\n1. ",
  "\n2. ",
  "\n> ",
  "\n```\n",
  "\n~~~\n",
  "\n``` `\n",
  "\n|a|\n",
] as const;

/**
 * One text: segments of nested prefixes and of openers, near the guard's
 * limits, each followed by what may or may not end a block, then enough
 * closers to nest them all, should a parser read the segments as one.
 */
const generated = (): string => {
  const [opener, closer] = pick(pairs);
  let text = "";
  let opened = 0;
  const segments = 1 + upTo(4);
  for (let segment = 0; segment < segments; segment += 1) {
    const count = random() < 0.5 ? upTo(499) : 250 + upTo(249);
    text += pick(leading);
    // Now and then past the thousand levels that overflow marked's stack.
    text += pick(prefixes).repeat(random() < 0.3 ? upTo(1500) : upTo(30));
    text += opener.repeat(count);
    text += pick(separators).replaceAll("\n", pick(endings));
    opened += count;
  }
  return `${text}b${closer.repeat(opened)}`;
};

/** Generous: the slowest text the guard accepts renders in under a second. */
const timeBound = 3000;

describe("the Markdown limits, against the parsers they guard", () => {
  it("lets through only texts its parsers render without throwing, in time", () => {
    const failures: { text: string; threw: string; ms: number }[] = [];
    let accepted = 0;
    for (let index = 0; index < 3000; index += 1) {
      const text = generated();
      if (!withinMarkdownLimits(text)) {
        continue;
      }
      accepted += 1;
      const started = performance.now();
      let threw = "";
      const record = (thrown: unknown): void => {
        threw = String(thrown);
      };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container, {
        onCaughtError: record,
        onUncaughtError: record,
      });
      try {
        flushSync(() => {
          root.render(<Markdown>{text}</Markdown>);
        });
      } catch (error) {
        record(error);
      }
      const ms = Math.round(performance.now() - started);
      root.unmount();
      container.remove();
      if (threw !== "" || ms > timeBound) {
        failures.push({ text: JSON.stringify(text.slice(0, 300)), threw, ms });
      }
    }
    // Enough of them pass the guard to say something: over 400 of the 3,000.
    expect({ enough: accepted > 400, failures }).toStrictEqual({
      enough: true,
      failures: [],
    });
  }, 300_000);
});

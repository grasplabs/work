import { Linter } from "eslint";
import type { ESLint } from "eslint";
import { describe, expect, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";

// grasp/no-slow-motion as the linter runs it, over the forms of motion
// Grasp's code writes: what it refuses and what it lets through.

const linter = new Linter({ configType: "flat" });

/** What the rule says of `code`, JavaScript with JSX: the milliseconds it refused. */
const refused = (code: string): string[] =>
  linter
    .verify(
      code,
      [
        {
          files: ["**/*.jsx"],
          languageOptions: {
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          // SAFETY: the plugin is written to the rule API ESLint and oxlint share; its
          // own types name only the parts of a node and a context it reads.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY above
          plugins: { grasp: grasp as ESLint.Plugin },
          rules: { "grasp/no-slow-motion": "error" },
        },
      ],
      "motion.jsx"
    )
    .map((message) => message.message.split(" ")[0] ?? "");

describe("grasp/no-slow-motion", () => {
  it.each([
    [
      "a Tailwind duration",
      '<div className="transition-opacity duration-500" />',
      ["500"],
    ],
    [
      "a Motion transition, in seconds",
      "<motion.div transition={{ duration: 0.6 }} />",
      ["600"],
    ],
    [
      "a nested Motion transition",
      "<motion.div transition={{ scale: { duration: 0.4 } }} />",
      ["400"],
    ],
    [
      "an element.animate option, in ms",
      "el.animate([], { duration: 700 });",
      ["700"],
    ],
    ["an element.animate duration, bare", "el.animate([], 600);", ["600"]],
    [
      "a duration multiplied in calc()",
      '<div className="duration-[calc(2*200ms)]" />',
      ["400"],
    ],
    [
      "a duration it can't work out",
      '<div className="duration-[calc(var(--strength)*400ms)]" />',
      ["`calc(var(--strength)*400ms)`"],
    ],
  ])("refuses %s over 300 ms", (_name, code, ms) => {
    expect(refused(code)).toStrictEqual(ms);
  });

  it.each([
    ["a quick Tailwind duration", '<div className="duration-200" />'],
    [
      "a duration divided in calc()",
      '<div className="duration-[calc(600ms/3)]" />',
    ],
    ["a quick bare element.animate", "el.animate([], 250);"],
    ["a toast's time, which is not motion", "toast({ duration: 4000 });"],
    [
      "a loop with repeat: Infinity",
      "<motion.div transition={{ duration: 2, repeat: Infinity }} />",
    ],
    [
      "a loop with repeat: Number.POSITIVE_INFINITY",
      "<motion.div transition={{ duration: 2, repeat: Number.POSITIVE_INFINITY }} />",
    ],
  ])("lets %s through", (_name, code) => {
    expect(refused(code)).toStrictEqual([]);
  });
});

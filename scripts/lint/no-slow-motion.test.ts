import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";
import { LIMIT_MS } from "./slow-motion.ts";

// grasp/no-slow-motion as oxlint runs it, over the forms of motion
// Grasp's code writes: what it refuses and what it lets through.

// Its cases as Vitest's own: RuleTester takes them through its static
// `describe` and `it`.
Object.assign(RuleTester, { describe, it });

const tester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

/** `code`, JavaScript with JSX, refused for taking `ms` milliseconds. */
const slow = (name: string, code: string, ms: number) => ({
  name,
  code,
  filename: "motion.jsx",
  errors: [
    { messageId: "slow", data: { ms: String(ms), limit: String(LIMIT_MS) } },
  ],
});

/** `code`, JavaScript with JSX, let through. */
const quick = (name: string, code: string) => ({
  name,
  code,
  filename: "motion.jsx",
});

/**
 * Whether `value` is a rule as RuleTester takes it. The plugin is written
 * to oxlint's rule API, but its own types name only the parts of a node and
 * a context it reads, so they don't line up with oxlint's.
 */
const isRule = (value: unknown): value is Parameters<RuleTester["run"]>[1] =>
  typeof value === "object" && value !== null && "create" in value;

const rule = grasp.rules["no-slow-motion"];
if (!isRule(rule)) {
  throw new Error("grasp/no-slow-motion isn't a rule");
}

tester.run("grasp/no-slow-motion", rule, {
  invalid: [
    slow(
      "a Tailwind duration",
      '<div className="transition-opacity duration-500" />',
      500
    ),
    slow(
      "a Motion transition, in seconds",
      "<motion.div transition={{ duration: 0.6 }} />",
      600
    ),
    slow(
      "a nested Motion transition",
      "<motion.div transition={{ scale: { duration: 0.4 } }} />",
      400
    ),
    slow(
      "an element.animate option, in ms",
      "el.animate([], { duration: 700 });",
      700
    ),
    slow("an element.animate duration, bare", "el.animate([], 600);", 600),
    slow(
      "a duration multiplied in calc()",
      '<div className="duration-[calc(2*200ms)]" />',
      400
    ),
    {
      name: "a duration it can't work out",
      code: '<div className="duration-[calc(var(--strength)*400ms)]" />',
      filename: "motion.jsx",
      errors: [
        {
          messageId: "unread",
          data: { value: "calc(var(--strength)*400ms)" },
        },
      ],
    },
  ],
  valid: [
    quick("a quick Tailwind duration", '<div className="duration-200" />'),
    quick(
      "a duration divided in calc()",
      '<div className="duration-[calc(600ms/3)]" />'
    ),
    quick("a quick bare element.animate", "el.animate([], 250);"),
    quick("a toast's time, which is not motion", "toast({ duration: 4000 });"),
    quick(
      "a loop with repeat: Infinity",
      "<motion.div transition={{ duration: 2, repeat: Infinity }} />"
    ),
    quick(
      "a loop with repeat: Number.POSITIVE_INFINITY",
      "<motion.div transition={{ duration: 2, repeat: Number.POSITIVE_INFINITY }} />"
    ),
  ],
});

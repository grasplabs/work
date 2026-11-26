import path from "node:path";

import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";

// grasp/no-class-strings as oxlint runs it: apps/web has no Tailwind, so a
// class list written as text is refused, and a class name StyleX made
// passes.

Object.assign(RuleTester, { describe, it });

const tester = new RuleTester();

const filename = path.join(
  import.meta.dirname,
  "../../apps/web/src/classes.tsx"
);

const styles = `
import * as stylex from "@stylexjs/stylex";
const looks = stylex.create({ row: { display: "flex" } });
`;

/** Whether `value` is a rule as RuleTester takes it (the plugin's own types name only what it reads). */
const isRule = (value: unknown): value is Parameters<RuleTester["run"]>[1] =>
  typeof value === "object" && value !== null && "create" in value;

const rule = grasp.rules["no-class-strings"];
if (!isRule(rule)) {
  throw new Error("grasp/no-class-strings isn't a rule");
}

tester.run("grasp/no-class-strings", rule, {
  valid: [
    {
      name: "StyleX spread on an element",
      code: `${styles}const Row = () => <div {...stylex.props(looks.row)} />;`,
      filename,
    },
    {
      name: "a class name StyleX made, handed to a headless part",
      code: `${styles}const Row = () => <Item className={stylex.props(looks.row).className} />;`,
      filename,
    },
    {
      name: "a class name passed on from a prop",
      code: "const Row = ({ className }) => <div className={className} />;",
      filename,
    },
  ],
  invalid: [
    {
      name: "a class list as a string",
      code: 'const Row = () => <div className="flex gap-2" />;',
      filename,
      errors: [{ messageId: "found" }],
    },
    {
      name: "a class list in an expression",
      code: 'const Row = () => <p className={"text-sm"} />;',
      filename,
      errors: [{ messageId: "found" }],
    },
    {
      name: "a template",
      code: "const Row = () => <div className={`flex gap-2`} />;",
      filename,
      errors: [{ messageId: "found" }],
    },
    {
      name: "a branch of a condition, on a component",
      code: 'const Row = ({ on }) => <Item className={on ? "w-44" : undefined} />;',
      filename,
      errors: [{ messageId: "found" }],
    },
    {
      name: "an argument of a call",
      code: 'const Row = ({ on }) => <div className={cn("flex", on && "gap-2")} />;',
      filename,
      errors: [{ messageId: "found" }],
    },
  ],
});

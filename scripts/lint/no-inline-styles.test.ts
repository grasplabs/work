import path from "node:path";

import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";

// grasp/no-inline-styles as oxlint runs it: shadcn's rule, with a Damsko
// component's StyleX `style` let through.

// Its cases as Vitest's own: RuleTester takes them through its static
// `describe` and `it`.
Object.assign(RuleTester, { describe, it });

const tester = new RuleTester();

const filename = path.join(
  import.meta.dirname,
  "../../apps/web/src/placed.tsx"
);

const styles = `
import * as stylex from "@stylexjs/stylex";
const layout = stylex.create({ wide: { flexGrow: 1 } });
`;

/**
 * Whether `value` is a rule as RuleTester takes it. The plugin is written
 * to oxlint's rule API, but its own types name only the parts of a node and
 * a context it reads, so they don't line up with oxlint's.
 */
const isRule = (value: unknown): value is Parameters<RuleTester["run"]>[1] =>
  typeof value === "object" && value !== null && "create" in value;

const rule = grasp.rules["no-inline-styles"];
if (!isRule(rule)) {
  throw new Error("grasp/no-inline-styles isn't a rule");
}

tester.run("grasp/no-inline-styles", rule, {
  valid: [
    {
      name: "a Damsko component placed by a StyleX style",
      code: `import { Button } from "@grasp-os/ui/components/button";${styles}
const Save = () => <Button style={layout.wide}>Save</Button>;`,
      filename,
    },
    {
      name: "a Damsko component placed by StyleX styles, one of them conditional",
      code: `import { Card, CardContent } from "@grasp-os/ui/components/card";${styles}
const Note = ({ wide }) => (
  <Card style={[layout.wide, wide && layout.wide]}>
    <CardContent />
  </Card>
);`,
      filename,
    },
    {
      name: "an element placed by stylex.props",
      code: `${styles}
const Row = () => <div {...stylex.props(layout.wide)} />;`,
      filename,
    },
    {
      name: "a custom property, as shadcn's rule lets through",
      code: `const Bar = () => <div style={{ "--progress": "40%" }} />;`,
      filename,
    },
  ],
  invalid: [
    {
      name: "an element's own inline style",
      code: `const Red = () => <div style={{ color: "red" }} />;`,
      filename,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      name: "a StyleX style on an element, which takes stylex.props",
      code: `${styles}
const Row = () => <div style={layout.wide} />;`,
      filename,
      errors: [{ messageId: "dynamicStyle" }],
    },
    {
      name: "a kit component's inline style",
      code: `import { Button } from "@grasp-os/app-kit/components/button";
const Save = () => <Button style={{ width: 120 }}>Save</Button>;`,
      filename,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      name: "a type imported from Damsko, which is no component",
      code: `import type { LayoutStyle as Button } from "@grasp-os/ui/lib/utils";
const Save = () => <Button style={{ width: 120 }} />;`,
      filename,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      name: "a type named among Damsko's imports, which is no component",
      code: `import { type LayoutStyle as Button } from "@grasp-os/ui/lib/utils";
const Save = () => <Button style={{ width: 120 }} />;`,
      filename,
      errors: [{ messageId: "inlineStyle" }],
    },
  ],
});

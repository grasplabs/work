import path from "node:path";

import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";

// grasp/no-inline-styles as oxlint runs it: shadcn's rule, with StyleX
// styles let through to a component's `style`, Damsko's or the product's
// own that takes Damsko's LayoutStyle.

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

const layoutStyle = `
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { Card } from "@grasp-os/ui/components/card";
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
      name: "a product component that takes Damsko's LayoutStyle, placed and passing it on",
      code: `${layoutStyle}${styles}
const SaveBar = ({ style }: { style?: LayoutStyle }) => <Card style={style} />;
const Page = () => <SaveBar style={layout.wide} />;`,
      filename,
    },
    {
      name: "its prop declared in an interface, with a default, or read off props",
      code: `${layoutStyle}${styles}
interface Props { readonly title: string; style?: LayoutStyle }
export type Wide = { style: LayoutStyle | undefined } & { title: string };
function SaveBar({ title, style = undefined }: Props) { return <Card style={style}>{title}</Card>; }
const Bar = (props: Wide) => <Card style={props.style} />;
const Renamed = ({ style: placement }: Props) => <Card style={[layout.wide, placement]} />;`,
      filename,
    },
    {
      name: "a component from another file of the product, or a part of a Damsko component",
      code: `${styles}
import { SaveBar } from "./save-bar.tsx";
import { Sidebar } from "@grasp-os/ui/components/sidebar";
const Page = () => (
  <Sidebar.Item style={layout.wide}>
    <SaveBar style={layout.wide} />
  </Sidebar.Item>
);`,
      filename,
    },
    {
      name: "StyleX styles picked by a key, through a const, or from create imported by name",
      code: `import { create } from "@stylexjs/stylex";
import { Button } from "@grasp-os/ui/components/button";
const sizes = create({ small: { width: 80 }, large: { width: 160 } });
const Save = ({ size, wide }: { size: "small" | "large"; wide: boolean }) => {
  const placement = wide ? sizes.large : null;
  return <Button style={[sizes[size], placement ?? sizes.small, wide ? undefined : false]}>Save</Button>;
};`,
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
      errors: [{ messageId: "stylexStyle" }],
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
      name: "an inline object on a Damsko component, which its type would refuse too",
      code: `import { Button } from "@grasp-os/ui/components/button";
const Save = () => <Button style={{ width: 120 }}>Save</Button>;`,
      filename,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      name: "an inline object on a product component",
      code: `import { SaveBar } from "./save-bar.tsx";
const Page = () => <SaveBar style={{ marginTop: 8 }} />;`,
      filename,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      name: "StyleX styles on a kit component, whose style is an inline style",
      code: `import { Button } from "@grasp-os/app-kit/components/button";${styles}
const Save = () => <Button style={layout.wide}>Save</Button>;`,
      filename,
      errors: [{ messageId: "stylexStyle" }],
    },
    {
      name: "a LayoutStyle prop given to an element, which takes stylex.props",
      code: `${layoutStyle}
const SaveBar = ({ style }: { style?: LayoutStyle }) => <div style={style} />;`,
      filename,
      errors: [{ messageId: "stylexStyle" }],
    },
    {
      name: "an inline object given to a prop of another type, or of none, that passes it on",
      code: `import type { CSSProperties } from "react";${layoutStyle}
const One = ({ style }: { style?: CSSProperties }) => <Card style={style} />;
const Two = ({ style }) => <Card style={style} />;
const Page = () => (
  <>
    <One style={{ color: "red" }} />
    <Two style={{ width: 120 }} />
  </>
);`,
      filename,
      errors: [{ messageId: "inlineStyle" }, { messageId: "inlineStyle" }],
    },
    {
      name: "a LayoutStyle of the file's own, not Damsko's",
      code: `import type { CSSProperties } from "react";
import { Card } from "@grasp-os/ui/components/card";
type LayoutStyle = CSSProperties;
const SaveBar = ({ style }: { style?: LayoutStyle }) => <Card style={style} />;
const Page = () => <SaveBar style={{ color: "red" }} />;`,
      filename,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      name: "a LayoutStyle prop assigned to, and styles in a let",
      code: `import * as stylex from "@stylexjs/stylex";${layoutStyle}
let layout = stylex.create({ wide: { flexGrow: 1 } });
const SaveBar = ({ style }: { style?: LayoutStyle }) => {
  style = layout.wide;
  return <Card style={style} />;
};
const Wide = () => <Card style={layout.wide} />;`,
      filename,
      errors: [{ messageId: "dynamicStyle" }, { messageId: "dynamicStyle" }],
    },
    {
      name: "a plain object of styles, a cast, a call and a spread",
      code: `${layoutStyle}${styles}
const plain = { wide: { flexGrow: 1 } };
const made = () => layout.wide;
const all = [layout.wide];
const Page = () => (
  <>
    <Card style={plain.wide} />
    <Card style={{ flexGrow: 1 } as LayoutStyle} />
    <Card style={made()} />
    <Card style={[...all]} />
  </>
);`,
      filename,
      errors: [
        { messageId: "inlineStyle" },
        { messageId: "inlineStyle" },
        { messageId: "dynamicStyle" },
        { messageId: "dynamicStyle" },
      ],
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

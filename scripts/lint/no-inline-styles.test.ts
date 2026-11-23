import path from "node:path";

import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";

import grasp from "./grasp-plugin.ts";

// grasp/no-inline-styles as oxlint runs it: inline style objects refused,
// with StyleX styles let through to a component's `style`, Damsko's or the
// product's own that takes Damsko's LayoutStyle.

// Its cases as Vitest's own: RuleTester takes them through its static
// `describe` and `it`.
Object.assign(RuleTester, { describe, it });

const tester = new RuleTester();

const filename = path.join(
  import.meta.dirname,
  "../../apps/web/src/placed.tsx"
);

/** A styles module of the app, whose exports the rule holds. */
const stylesFile = path.join(
  import.meta.dirname,
  "../../apps/web/src/frame/page.styles.ts"
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
      name: "a custom property, which the component linter's rule lets through",
      code: `const Bar = () => <div style={{ "--progress": "40%" }} />;`,
      filename,
    },
    {
      name: "StyleX styles imported from a styles module of the app, by name or renamed",
      code: `${layoutStyle}
import { shared, sizes as widths } from "./frame/page.styles.ts";
import { grow } from "../shared/row.styles.ts";
import { inboxStyles } from "./inbox/inbox-styles.ts";
import { styles } from "./app-card/styles.ts";
const Page = ({ size }: { size: "small" | "large" }) => (
  <>
    <Card style={shared.wide} />
    <Card style={[widths[size], grow.one, inboxStyles.row, styles.link]} />
  </>
);`,
      filename,
    },
    {
      name: "anything that satisfies Damsko's LayoutStyle, which the type checker holds",
      code: `${layoutStyle}${styles}
const Page = ({ extra, wide }: { extra: unknown; wide: boolean }) => {
  const placement = (wide ? layout.wide : null) satisfies LayoutStyle | null;
  return (
    <>
      <Card style={layout.wide satisfies LayoutStyle} />
      <Card style={placement} />
      <Card style={extra satisfies LayoutStyle} />
    </>
  );
};`,
      filename,
    },
    {
      name: "a member read with optional chaining or a non-null assertion",
      code: `${layoutStyle}${styles}
const SaveBar = (props?: { style?: LayoutStyle }) => <Card style={props?.style} />;
const Page = () => (
  <>
    <Card style={layout?.wide} />
    <Card style={layout.wide!} />
    <SaveBar style={layout?.["wide"]} />
  </>
);`,
      filename,
    },
    {
      name: "StyleX's create under another name, or its default export",
      code: `import { create as make } from "@stylexjs/stylex";
import sx from "@stylexjs/stylex";
import { Button } from "@grasp-os/ui/components/button";
const one = make({ wide: { flexGrow: 1 } });
const two = sx.create({ wide: { flexGrow: 1 } });
const Save = () => <Button style={[one.wide, two.wide]}>Save</Button>;`,
      filename,
    },
    {
      name: "a styles module that exports only what StyleX's create made, and types",
      code: `import * as stylex from "@stylexjs/stylex";
import { create } from "@stylexjs/stylex";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
export const shared = stylex.create({ wide: { flexGrow: 1 } });
const sizes = create({ small: { width: 80 } });
const width = 80;
export { sizes };
export type Size = keyof typeof sizes;
export interface Placed { style?: LayoutStyle }
export type { LayoutStyle };`,
      filename: stylesFile,
    },
    {
      name: "a styles module's arrays of StyleX styles, as const, picked from by a page",
      code: `import * as stylex from "@stylexjs/stylex";
export const styles = stylex.create({ one: { width: 1 }, two: { width: 2 } });
export const sizes = [null, styles.one, styles.two] as const;`,
      filename: stylesFile,
    },
    {
      name: "a component the file declares, given StyleX styles",
      code: `${layoutStyle}${styles}
import { sizes } from "./frame/page.styles.ts";
import { forwardRef, memo } from "react";
function Bar({ style }: { style?: LayoutStyle }) { return <Card style={style} />; }
const Arrow = ({ style }: { style?: LayoutStyle }) => <Card style={style} />;
const Kept = memo(function Kept({ style }: { style?: LayoutStyle }) { return <Card style={style} />; });
const Forwarded = forwardRef((props: { style?: LayoutStyle }, ref) => <Card style={props.style} />);
const Page = ({ at }: { at: number }) => (
  <>
    <Bar style={[layout.wide, sizes[at]]} />
    <Arrow style={layout.wide} />
    <Kept style={layout.wide} />
    <Forwarded style={layout.wide} />
  </>
);`,
      filename,
    },
    {
      name: "Damsko's own styles module, which pages import by the package's name",
      code: `export const wide = { width: 1 };`,
      filename: path.join(
        import.meta.dirname,
        "../../packages/ui/src/lib/styles.ts"
      ),
    },
    {
      name: "a module whose name only ends in styles, which is no styles module",
      code: `export const wide = { width: 1 };`,
      filename: path.join(
        import.meta.dirname,
        "../../apps/web/src/mystyles.ts"
      ),
    },
  ],
  invalid: [
    {
      name: "StyleX styles on another package's component, whose style is an inline style",
      code: `${styles}
import { Link } from "@tanstack/react-router";
import * as Motion from "motion/react";
const Tile = Math.random() > 0.5 ? "span" : "div";
const Alias = Link;
const Page = ({ Given }: { Given: typeof Link }) => (
  <>
    <Link to="/" style={layout.wide} />
    <Motion.div style={layout.wide} />
    <Given to="/" style={layout.wide} />
    <Unknown style={layout.wide} />
    <Tile style={layout.wide} />
    <Alias to="/" style={layout.wide} />
  </>
);`,
      filename,
      errors: [
        { messageId: "stylexStyle" },
        { messageId: "stylexStyle" },
        { messageId: "stylexStyle" },
        { messageId: "stylexStyle" },
        { messageId: "stylexStyle" },
        { messageId: "stylexStyle" },
      ],
    },
    {
      name: "a styles module of each name, held to its exports",
      code: `export const wide = { width: 1 };`,
      filename: path.join(
        import.meta.dirname,
        "../../apps/web/src/inbox/inbox-styles.ts"
      ),
      errors: [{ messageId: "stylesModule" }],
    },
    {
      name: "a styles module named styles.ts, held to its exports",
      code: `export const wide = { width: 1 };`,
      filename: path.join(
        import.meta.dirname,
        "../../apps/web/src/app-card/styles.ts"
      ),
      errors: [{ messageId: "stylesModule" }],
    },
    {
      name: "create, stylex or LayoutStyle shadowed by a binding of the file's own",
      code: `import * as stylex from "@stylexjs/stylex";
import { create } from "@stylexjs/stylex";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { Card } from "@grasp-os/ui/components/card";
const One = () => {
  const create = (styles: object) => styles;
  const layout = create({ wide: { width: 1 } });
  return <Card style={layout.wide} />;
};
const Two = () => {
  const stylex = { create: (styles: object) => styles };
  const layout = stylex.create({ wide: { width: 1 } });
  return <Card style={layout.wide} />;
};
function Three<LayoutStyle>({ style }: { style?: LayoutStyle }) {
  return <Card style={style} />;
}
const Page = () => <Three style={{ color: "red" }} />;`,
      filename,
      errors: [
        { messageId: "dynamicStyle" },
        { messageId: "dynamicStyle" },
        { messageId: "inlineStyle" },
      ],
    },
    {
      name: "create from anywhere but StyleX, or a type-only import of it",
      code: `import { create } from "./my-styles.ts";
import type * as stylex from "@stylexjs/stylex";
import { Card } from "@grasp-os/ui/components/card";
const one = create({ wide: { width: 1 } });
const two = stylex.create({ wide: { width: 1 } });
const Page = () => <Card style={[one.wide, two.wide]} />;`,
      filename,
      errors: [{ messageId: "dynamicStyle" }],
    },
    {
      name: "styles imported from a module that is no styles module of the app, or as a namespace or default",
      code: `${layoutStyle}
import { shared } from "./frame/page.ts";
import { other } from "some-package/page.styles.ts";
import { mystyles } from "./frame/mystyles.ts";
import { focusRing } from "../../../packages/ui/src/lib/styles.ts";
import * as page from "./frame/page.styles.ts";
import fallback from "./frame/page.styles.ts";
const Page = () => (
  <>
    <Card style={shared.wide} />
    <Card style={other.wide} />
    <Card style={page.shared.wide} />
    <Card style={fallback.wide} />
    <Card style={mystyles.wide} />
    <Card style={focusRing.ring} />
  </>
);`,
      filename,
      errors: [
        { messageId: "dynamicStyle" },
        { messageId: "dynamicStyle" },
        { messageId: "dynamicStyle" },
        { messageId: "dynamicStyle" },
        { messageId: "dynamicStyle" },
        { messageId: "dynamicStyle" },
      ],
    },
    {
      name: "an inline object that satisfies another type, or a LayoutStyle of the file's own",
      code: `import type { CSSProperties } from "react";
import { Card } from "@grasp-os/ui/components/card";
type LayoutStyle = CSSProperties;
const Page = () => (
  <>
    <Card style={{ width: 1 } satisfies CSSProperties} />
    <Card style={{ width: 1 } satisfies LayoutStyle} />
  </>
);`,
      filename,
      errors: [{ messageId: "inlineStyle" }, { messageId: "inlineStyle" }],
    },
    {
      name: "a styles module that exports anything else",
      code: `import * as stylex from "@stylexjs/stylex";
const sizes = stylex.create({ small: { width: 80 } });
const plain = { wide: { width: 1 } };
export const wide = { width: 1 };
export let mutable = stylex.create({ wide: { width: 1 } });
export const made = () => sizes;
export function pick() { return sizes.small; }
export { plain };
export { other } from "./other.styles.ts";
export * from "./more.styles.ts";
export default sizes;`,
      filename: stylesFile,
      errors: [
        { messageId: "stylesModule" },
        { messageId: "stylesModule" },
        { messageId: "stylesModule" },
        { messageId: "stylesModule" },
        { messageId: "stylesModule" },
        { messageId: "stylesModule" },
        { messageId: "stylesModule" },
        { messageId: "stylesModule" },
      ],
    },
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

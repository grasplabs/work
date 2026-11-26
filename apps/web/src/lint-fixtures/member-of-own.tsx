/**
 * Linted by scripts/lint/no-inline-styles.test.ts with the repository's own
 * config: a member of a component the feature owns, here or in another
 * module, takes StyleX styles only if it is itself Damsko's or the
 * feature's own. Each refusal carries a disable comment, which fails if
 * unused.
 */
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { Menu } from "./menu.tsx";
import { Panel } from "./own-panel.tsx";

const layout = stylex.create({ wide: { flexGrow: 1 } });

const Local = () => null;
Local.Item = Link;
Local.Panel = Panel;

export const MemberOfOwn = () => (
  <>
    <Menu.Panel style={layout.wide} />
    <Local.Panel style={layout.wide} />
    {/* oxlint-disable-next-line grasp/no-inline-styles -- the router's Link, a member of another module's component */}
    <Menu.Item style={layout.wide} to="/" />
    {/* oxlint-disable-next-line grasp/no-inline-styles -- the router's Link, a member of this file's component */}
    <Local.Item style={layout.wide} to="/" />
  </>
);

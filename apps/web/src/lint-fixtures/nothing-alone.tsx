/**
 * Linted by scripts/lint/no-inline-styles.test.ts with the repository's own
 * config: a `style` that is only nothing passes no StyleX styles, so it is
 * no placement, on an element of the page or another package's component,
 * and the component linter's rule lets it through. Beside StyleX styles,
 * nothing still makes a placement, which these refuse.
 */
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

const layout = stylex.create({ wide: { flexGrow: 1 } });
const none = undefined;

export const NothingAlone = ({ open }: { open: boolean }) => (
  <>
    <div style={undefined} />
    <Link to="/" style={undefined} />
    <Link to="/" style={open ? undefined : undefined} />
    <Link to="/" style={open ? none : undefined} />
    {/* oxlint-disable-next-line grasp/no-inline-styles -- StyleX styles beside nothing, to an element of the page */}
    <div style={open ? layout.wide : undefined} />
  </>
);

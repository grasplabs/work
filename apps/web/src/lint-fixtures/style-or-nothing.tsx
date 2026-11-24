/**
 * Linted by scripts/lint/no-inline-styles.test.ts with the repository's own
 * config, whose globals bind `undefined`: a Damsko component's `style` may
 * be StyleX styles or nothing in each form below. Nothing imports it.
 */
import { Button } from "@grasp-os/ui/components/button";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const layout = stylex.create({ wide: { flexGrow: 1 } });

export const StyleOrNothing = ({
  wide,
  children,
}: {
  wide: boolean;
  children: ReactNode;
}) => (
  <>
    <Button style={wide ? layout.wide : undefined}>{children}</Button>
    <Button style={[layout.wide, undefined]}>{children}</Button>
    <Button style={layout.wide ?? undefined}>{children}</Button>
    {/* oxlint-disable-next-line grasp/no-inline-styles -- the rule runs here: it refuses this inline style object, or the comment is unused and fails */}
    <div style={{ flexGrow: 1 }} />
  </>
);

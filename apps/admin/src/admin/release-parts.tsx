/**
 * The rows Platform's pages draw in their panels, as the organization's
 * Setup draws its own (src/admin/setup.tsx): facts as rows.
 */
import { CardContent } from "@grasp-os/ui/components/card";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  // A fact that needs someone, in the warning's colour.
  attention: { color: colors.warning },
});

/** One fact: what it is, and the fact, in type when it is an id or a hash. */
export interface Fact {
  label: string;
  value: ReactNode;
  mono?: boolean;
  attention?: boolean;
}

/** A few facts as rows: what it is on the left, the fact on the right. */
export const Facts = ({ rows }: { rows: readonly Fact[] }) => (
  <CardContent>
    <KeyValueList
      divided
      items={rows.map(({ label, value, mono, attention }) => ({
        id: label,
        label,
        value:
          attention === true ? (
            <span {...stylex.props(styles.attention)}>{value}</span>
          ) : (
            value
          ),
        mono,
      }))}
      orientation="horizontal"
    />
  </CardContent>
);

/** A list, in words: `none` when it's empty. */
export const listed = (items: readonly string[]): string =>
  items.join(", ") || "none";

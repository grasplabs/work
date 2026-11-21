// HoverCardDescription: a line or two about what the link leads to (hover-card.tsx).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { hoverCardStyles as styles } from "./styles";

/** Every prop a HoverCardDescription takes. */
export interface HoverCardDescriptionProps {
  /** A line or two about it, in plain words. */
  children: ReactNode;
  /**
   * A quiet fact instead, smaller and muted, such as when it last changed.
   * @default false
   */
  meta?: boolean;
}

/** A line about what the link leads to, or with `meta`, a quiet fact. */
export const HoverCardDescription = ({
  children,
  meta = false,
}: HoverCardDescriptionProps) => (
  <p {...stylex.props(meta ? styles.meta : styles.description)}>{children}</p>
);

// HoverCardTitle: what the link leads to, at the top of the card (hover-card.tsx).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { hoverCardStyles as styles } from "./styles";

/** Every prop a HoverCardTitle takes. */
export interface HoverCardTitleProps {
  /** The name of what the link leads to, in sentence case. */
  children: ReactNode;
}

/** The title: a step up from the card's text. */
export const HoverCardTitle = ({ children }: HoverCardTitleProps) => (
  <p {...stylex.props(styles.title)}>{children}</p>
);

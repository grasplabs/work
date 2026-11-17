// A real miniature of the interface, drawn in the tokens of whatever theme and mode hold it: a
// ground, a sidebar with its current row raised, a card with lines, the main action and the light.
// It is a picture, so it is hidden from screen readers; its tile's name says what it is.
import * as stylex from "@stylexjs/stylex";

import { switchStyles as styles } from "./styles";

export const Miniature = () => (
  <>
    <span {...stylex.props(styles.side)}>
      <span {...stylex.props(styles.bar, styles.barInk, styles.w60)} />
      <span {...stylex.props(styles.bar, styles.barCurrent)} />
      <span {...stylex.props(styles.bar, styles.w80)} />
      <span {...stylex.props(styles.bar, styles.w60)} />
    </span>
    <span {...stylex.props(styles.main)}>
      <span {...stylex.props(styles.bar, styles.barInk, styles.w45)} />
      <span {...stylex.props(styles.card)}>
        <span {...stylex.props(styles.bar, styles.barInk, styles.w60)} />
        <span {...stylex.props(styles.bar, styles.w80)} />
        <span {...stylex.props(styles.foot)}>
          <span {...stylex.props(styles.action)} />
          <span {...stylex.props(styles.light)} />
        </span>
      </span>
    </span>
  </>
);

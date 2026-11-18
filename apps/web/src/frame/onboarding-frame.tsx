import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { iconVars } from "../grasp/icons/icon.stylex.ts";
import { BrandGrasp, Icon } from "../grasp/icons/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { LanguageButton } from "../language-picker.tsx";

// The foot's height, and the same room kept at the top so the column
// stands in the middle of the window.
const FOOT = "4.5rem";
// How wide the column is: a form, or a chat (`wide`).
const NARROW_COLUMN = "24rem";
const WIDE_COLUMN = "42rem";

const styles = stylex.create({
  window: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100svh",
    backgroundColor: grasp.paper,
    color: grasp.text,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  top: { flexShrink: 0, height: FOOT },
  main: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    alignItems: "center",
    paddingInline: grasp.space4,
    paddingBlock: grasp.space2,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space8,
    width: "100%",
    maxWidth: NARROW_COLUMN,
    marginBlock: "auto",
    textAlign: "center",
  },
  wide: { maxWidth: WIDE_COLUMN, textAlign: "start" },
  foot: {
    position: "sticky",
    insetBlockEnd: 0,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    height: FOOT,
    paddingInline: { default: grasp.space10, [media.belowPhone]: grasp.space4 },
    backgroundColor: grasp.paper,
  },
  mark: { display: "flex", [iconVars.size]: grasp.iconMd },
});

/**
 * A page for someone outside the product (sign-in, a guest's chat) in the
 * onboarding's frame: one centred column, the mark bottom left and the
 * language bottom right. `wide` holds a chat.
 */
export const OnboardingFrame = ({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) => (
  <div {...stylex.props(styles.window)}>
    <div aria-hidden="true" {...stylex.props(styles.top)} />
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.column, wide && styles.wide)}>
        {children}
      </div>
    </main>
    <footer {...stylex.props(styles.foot)}>
      <span {...stylex.props(styles.mark)}>
        <Icon icon={BrandGrasp} label="Grasp" />
      </span>
      <LanguageButton />
    </footer>
  </div>
);

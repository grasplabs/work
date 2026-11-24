import { Icon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { GraspLogo } from "../connections/brand-logos.ts";
import { LanguageButton } from "./language-button.tsx";

// The foot's height, and the same room kept at the top so the column
// stands in the middle of the window.
const FOOT = "4.5rem";
// How wide the column is: a form.
const NARROW_COLUMN = "24rem";

const styles = stylex.create({
  window: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100svh",
    backgroundColor: colors.background,
    color: colors.bodyForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  top: { flexShrink: 0, height: FOOT },
  main: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    alignItems: "center",
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space[8],
    width: "100%",
    maxWidth: NARROW_COLUMN,
    marginBlock: "auto",
    textAlign: "center",
  },
  foot: {
    position: "sticky",
    insetBlockEnd: 0,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    height: FOOT,
    paddingInline: { default: space[10], [media.maxSm]: space[4] },
    backgroundColor: colors.background,
  },
  mark: { display: "flex", [iconVars.size]: size.iconDefault },
});

/**
 * A page for someone outside the product (signing in with a code, a
 * guest, Grasp staff) in the onboarding's frame: one centred column, the
 * mark bottom left and the language bottom right.
 */
export const OnboardingFrame = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.window)}>
    <div aria-hidden="true" {...stylex.props(styles.top)} />
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.column)}>{children}</div>
    </main>
    <footer {...stylex.props(styles.foot)}>
      <span {...stylex.props(styles.mark)}>
        <Icon icon={GraspLogo} label="Grasp" />
      </span>
      <LanguageButton />
    </footer>
  </div>
);

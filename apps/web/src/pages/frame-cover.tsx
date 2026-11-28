import { Spinner } from "@grasp-os/ui/components/spinner";
import { colors, duration, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// What a page's frame shows while there is nothing of the page to see:
// never the frame itself, which is blank, then an empty document, until
// the page's own code has drawn (core's page-frame.ts). The frame goes on
// starting under the cover, unseen and inert, so it is there to fade in
// the moment it runs; nothing of it is reached before.

const styles = stylex.create({
  stage: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  frame: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    opacity: 1,
    transitionProperty: { default: "opacity", [media.reducedMotion]: "none" },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  unseen: { opacity: 0 },
  over: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
  },
  // On the page's own ground, which the App draws on once it runs.
  loading: {
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: space[6],
    backgroundColor: colors.background,
  },
});

/** A frame, `children`, under `cover` while there is one (null: none). */
export const FrameCover = ({
  cover,
  children,
}: {
  cover: ReactNode;
  children: ReactNode;
}) => {
  const covered = cover !== null && cover !== undefined;
  return (
    <div {...stylex.props(styles.stage)}>
      <div
        inert={covered}
        {...stylex.props(styles.frame, covered && styles.unseen)}
      >
        {children}
      </div>
      {covered ? <div {...stylex.props(styles.over)}>{cover}</div> : null}
    </div>
  );
};

/** A frame on its way: the design system's spinner, its `label` said to a screen reader. */
export const FrameLoading = ({ label }: { label: string }) => (
  <div {...stylex.props(styles.loading)}>
    <Spinner aria-label={label} size="lg" />
  </div>
);

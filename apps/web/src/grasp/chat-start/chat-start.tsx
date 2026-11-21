"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId, useRef } from "react";
import type { ReactNode } from "react";

import { Backdrop, defaultScenes } from "../backdrop/backdrop";
import type { BackdropLayoutStyle } from "../backdrop/backdrop";
import { defaultLook } from "../backdrop/look";
import type { BackdropLook } from "../backdrop/look";
import { grasp, media } from "../tokens/tokens.stylex";

/** Every prop a ChatStart takes. */
export interface ChatStartProps {
  /** The question the screen asks ("What should we look at today?"). */
  title: string;
  /** The box to ask in: a Composer with `surface="glass"`. */
  children: ReactNode;
  /** What stands under the box, such as a few things to ask. */
  below?: ReactNode;
  /**
   * What stands behind: a scene, a dither, sand, or `"none"`. Keeping a person's choice is the
   * product's.
   * @default defaultLook
   */
  variant?: BackdropLook;
  /** @deprecated Use `variant`. */
  look?: BackdropLook;
  /**
   * Where the scene pictures are served from, as Backdrop's `scenes`.
   * @default "/backdrops/"
   */
  scenes?: string;
  /**
   * The level of the question's heading: 1 where it is the page's title, 2 inside a page that has one.
   * @default 1
   */
  headingLevel?: 1 | 2;
  /** @deprecated Use `layout`. */
  style?: BackdropLayoutStyle;
  /** Layout only: where the screen sits and how tall it is. */
  layout?: BackdropLayoutStyle;
}

const NARROW = media.belowPhone;

const styles = stylex.create({
  // The backdrop's box, a column the screen grows in: so a height given in any unit (a length, a
  // percentage of a flex parent, the App shell's card) fills, and the question stays centred.
  fill: {
    display: "flex",
    flexDirection: "column",
  },
  // The whole screen: it fills the backdrop, as tall as the caller makes it, and stands its column
  // in the middle.
  screen: {
    flexGrow: 1,
    minHeight: "inherit",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: "100%",
    paddingInline: { default: grasp.space6, [NARROW]: grasp.space4 },
    paddingBlock: grasp.space12,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.chatStartGap,
    width: "100%",
    maxWidth: grasp.chatStartWidth,
    // The product's column stands a little above the middle: room under it, none over it.
    paddingBottom: grasp.space10,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  title: {
    margin: 0,
    fontFamily: grasp.fontSerif,
    fontSize: { default: grasp.titleLg, [NARROW]: grasp.titleMd },
    lineHeight: { default: grasp.titleLgLine, [NARROW]: grasp.titleMdLine },
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
    textAlign: "center",
    textWrap: "balance",
    overflowWrap: "anywhere",
    color: grasp.ink,
  },
  below: {
    width: "100%",
    minWidth: 0,
  },
});

/** The screen a chat starts on: the question and the box to ask in, on a backdrop. */
export const ChatStart = ({
  title,
  children,
  below,
  look: lookDeprecated,
  variant: look = lookDeprecated ?? defaultLook,
  scenes = defaultScenes,
  headingLevel = 1,
  style: styleProp,
  layout,
}: ChatStartProps) => {
  const column = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const Title = headingLevel === 1 ? "h1" : "h2";
  return (
    <Backdrop
      clear={column}
      variant={look}
      scenes={scenes}
      fadeFoot
      layout={[styles.fill, layout ?? styleProp]}
    >
      <section aria-labelledby={titleId} {...stylex.props(styles.screen)}>
        <div
          data-slot="chat-start"
          ref={column}
          {...stylex.props(styles.column)}
        >
          <Title
            id={titleId}
            data-slot="chat-start-title"
            {...stylex.props(styles.title)}
          >
            {title}
          </Title>
          {children}
          {below !== undefined && below !== null ? (
            <div {...stylex.props(styles.below)}>{below}</div>
          ) : null}
        </div>
      </section>
    </Backdrop>
  );
};

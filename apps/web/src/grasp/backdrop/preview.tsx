"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useRef } from "react";

import { Composer } from "../composer/composer";
import { grasp } from "../tokens/tokens.stylex";
import { defaultScenes } from "./backdrop";
import type { BackdropLayoutStyle } from "./backdrop";
import { BackdropField } from "./field";
import { byNewName, schemeOf } from "./look";
import type { BackdropLook } from "./look";

/** Every prop a BackdropPreview takes. */
export interface BackdropPreviewProps {
  /** The look it shows. */
  variant?: BackdropLook;
  /** @deprecated Use `variant`. */
  look?: BackdropLook;
  /**
   * The page's question, as it stands on the look.
   * @default "What should we look at today?"
   */
  title?: string;
  /**
   * The words in the box to ask in, as the page shows them.
   * @default "Ask anything"
   */
  placeholder?: string;
  /**
   * Its name for who can't see it.
   * @default "Preview of your chat backdrop"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * Where the scene pictures are served from, as Backdrop's `scenes`.
   * @default "/backdrops/"
   */
  scenes?: string;
  /** @deprecated Use `layout`. */
  style?: BackdropLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: BackdropLayoutStyle;
}

const styles = stylex.create({
  frame: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: grasp.backdropPreviewRatio,
    boxSizing: "border-box",
    width: "100%",
    margin: 0,
    overflow: "hidden",
    borderRadius: grasp.shellCardCorner,
    // The system's raised surface: green-tinted in dark as every other surface (the shell's card is
    // a neutral grey there, and read as off-theme over a green page).
    backgroundColor: grasp.raised,
    boxShadow: grasp.shellCardShadow,
  },
  // On a scene, which is night, what stands on it turns light.
  onNight: {
    colorScheme: "dark",
    color: grasp.text,
  },
  words: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space4,
    width: grasp.backdropPreviewWords,
  },
  title: {
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleSm,
    lineHeight: grasp.titleSmLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
    textAlign: "center",
    color: grasp.ink,
  },
  // The box to ask in, the page's own Composer on glass, as wide as the words up to the
  // Composer's own width, and centred under the question as on the page (left in a wider room it
  // stood about 145px off the heading's centre at 1440).
  box: {
    display: "grid",
    justifyItems: "center",
    width: "100%",
  },
});

/** The preview's Composer sends nothing: it is a picture of the box. */
const noSend = () => {
  // Nothing to send.
};

/** `look` as Chat's own page shows it, small and live. */
export const BackdropPreview = ({
  look: lookDeprecated,
  variant,
  title = "What should we look at today?",
  placeholder = "Ask anything",
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "Preview of your chat backdrop",
  scenes = defaultScenes,
  style: styleProp,
  layout,
}: BackdropPreviewProps) => {
  const look = byNewName(
    variant,
    lookDeprecated,
    "BackdropPreview: pass `variant`."
  );
  const words = useRef<HTMLDivElement>(null);
  const scheme = schemeOf(look);
  return (
    <figure
      aria-label={label}
      data-slot="backdrop-preview"
      data-backdrop={look.backdrop}
      data-theme={scheme}
      {...stylex.props(
        styles.frame,
        scheme === "dark" && styles.onNight,
        layout ?? styleProp
      )}
    >
      <BackdropField clear={words} look={look} scenes={scenes} small />
      <div aria-hidden="true" ref={words} {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.title)}>{title}</span>
        <div inert {...stylex.props(styles.box)}>
          <Composer
            surface="glass"
            compact
            aria-label={placeholder}
            placeholder={placeholder}
            failedLabel=""
            onSend={noSend}
          />
        </div>
      </div>
    </figure>
  );
};

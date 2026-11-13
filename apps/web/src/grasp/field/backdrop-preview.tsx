import * as stylex from "@stylexjs/stylex";
import { useRef } from "react";

import { frame } from "../frame/frame.stylex.ts";
import { grasp } from "../tokens/tokens.stylex.ts";
import { BackdropField } from "./backdrop.tsx";
import { schemeOf } from "./look.ts";
import type { Look } from "./look.ts";

// A look as Chat's own page shows it, small: the backdrop itself, live,
// under the page's question and the shape of the box to ask in, so a look
// is seen before it is chosen (settings/backdrop-settings.tsx). A window
// on the backdrop, not a shrunk copy: its cells are the size they are on
// the page.

const styles = stylex.create({
  frame: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: "16 / 9",
    width: "100%",
    margin: 0,
    overflow: "hidden",
    borderRadius: frame.cardCorner,
    backgroundColor: frame.card,
    boxShadow: frame.cardShadow,
  },
  // On a scene, which is night, what stands on it turns light.
  onNight: {
    colorScheme: "dark",
  },
  words: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space4,
    width: "62%",
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
  // The box to ask in, as glass, as it is on the page.
  box: {
    width: "100%",
    height: "56px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: frame.rule,
    borderRadius: "14px",
    backgroundColor: `color-mix(in oklch, ${frame.card} 62%, transparent)`,
    backdropFilter: "blur(14px) saturate(1.5)",
  },
});

/** `look` as Chat's page shows it, named `label` for who can't see it. */
export const BackdropPreview = ({
  look,
  title,
  label,
}: {
  look: Look;
  /** The page's question, as it stands on the look. */
  title: string;
  label: string;
}) => {
  const words = useRef<HTMLDivElement>(null);
  return (
    <figure
      aria-label={label}
      {...stylex.props(
        styles.frame,
        schemeOf(look) === "dark" && styles.onNight
      )}
    >
      <BackdropField clear={words} look={look} />
      <div aria-hidden="true" ref={words} {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.title)}>{title}</span>
        <span {...stylex.props(styles.box)} />
      </div>
    </figure>
  );
};

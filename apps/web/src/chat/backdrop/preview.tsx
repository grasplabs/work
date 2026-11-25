import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@grasp-os/ui/components/prompt-input";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRef } from "react";

import { backdrop as tokens } from "./backdrop.stylex.ts";
import { BackdropField } from "./field.tsx";
import { schemeOf } from "./look.ts";
import type { BackdropLook } from "./look.ts";

// A look as Chat's own page shows it, small and live (#2503's library's
// BackdropPreview): the backdrop in a window as wide as a screen, the
// page's question on it and the box to ask in under it, as glass. The box
// is a picture of the box: nothing in it can be reached.

const styles = stylex.create({
  frame: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: tokens.previewRatio,
    boxSizing: "border-box",
    width: "100%",
    margin: 0,
    overflow: "hidden",
    borderRadius: radius.md,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: tokens.previewShadow,
  },
  // On a scene, which is night, what stands on it turns light, on night's
  // own ground until the scene has drawn (or where it can't).
  onNight: {
    color: colors.bodyForeground,
    backgroundColor: colors.brandNight,
  },
  words: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["4"],
    width: tokens.previewWords,
  },
  title: {
    fontFamily: font.serif,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingTitle,
    textAlign: "center",
    color: colors.foreground,
  },
  // The box, centred under the question as on the page.
  box: {
    display: "grid",
    justifyItems: "center",
    width: "100%",
  },
});

/** The preview's box sends nothing: it is a picture of the box. */
const noSend = () => {
  // Nothing to send.
};

/** `look` as Chat's own page shows it, small and live. */
export const BackdropPreview = ({ look }: { look: BackdropLook }) => {
  const { t } = useLingui();
  const words = useRef<HTMLDivElement>(null);
  const scheme = schemeOf(look);
  return (
    <figure
      aria-label={t`Preview of your chat background`}
      data-slot="backdrop-preview"
      data-backdrop={look.backdrop}
      data-mode={scheme}
      {...stylex.props(styles.frame, scheme === "dark" && styles.onNight)}
    >
      <BackdropField clear={words} look={look} small />
      <div aria-hidden="true" ref={words} {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.title)}>
          {t`What should we look at today?`}
        </span>
        <div inert {...stylex.props(styles.box)}>
          <PromptInput
            aria-label={t`Ask anything`}
            compact
            onSubmit={noSend}
            variant="glass"
          >
            <PromptInputBody>
              <PromptInputTextarea
                aria-label={t`Ask anything`}
                placeholder={t`Ask anything`}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools align="end">
                <PromptInputSubmit />
              </PromptInputTools>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </figure>
  );
};

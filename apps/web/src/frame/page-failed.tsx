import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type { CoreConnection, CoreReach } from "../core-connection.ts";
import { Backdrop } from "../grasp/backdrop/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import { CopyField } from "../grasp/copy-field/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";

// A page that failed, as Grasp UI's pattern draws it ("A page that
// failed", /patterns/empty-and-error-states): a calm dither behind, a real
// heading, one plain sentence, Try again (working, then failed again), a
// quiet way on, the one fact that can change by itself (whether Grasp can
// be reached, as the tab's connection finds it), and the reference to copy
// for support, last. It is said once as it appears; Try again says how it
// went on the button. In the App shell's card, or the whole window when
// the shell itself could not load.

const styles = stylex.create({
  // In the card, under the page's bar: the page's room, the words in its middle.
  page: {
    display: "grid",
    boxSizing: "border-box",
    width: "100%",
    minHeight: "32rem",
    flexGrow: 1,
    paddingInline: grasp.space6,
    paddingBlock: grasp.space12,
  },
  // The whole window, when the shell could not load.
  whole: {
    display: "grid",
    boxSizing: "border-box",
    width: "100%",
    minHeight: "100dvh",
    paddingInline: grasp.space6,
    paddingBlock: grasp.space12,
  },
  words: {
    display: "grid",
    justifyItems: "center",
    alignSelf: "center",
    justifySelf: "center",
    gap: grasp.space4,
    maxWidth: "28rem",
    textAlign: "center",
  },
  heading: {
    margin: 0,
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleLg,
    lineHeight: grasp.titleLgLine,
    fontWeight: grasp.weightRegular,
    color: grasp.ink,
  },
  sentence: {
    margin: 0,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.text,
    textWrap: "pretty",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: grasp.space2,
  },
  // The one fact that can change by itself, said as it changes.
  fact: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  dot: {
    width: 8,
    height: 8,
    flexShrink: 0,
    borderRadius: grasp.cornerCircle,
    // In forced colours a dot's fill is dropped: its edge stays.
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  reachable: { backgroundColor: grasp.success },
  unreachable: { backgroundColor: grasp.danger },
  checking: {
    backgroundColor: grasp.muted,
    // A slow breath while it checks; still for anyone who asked for less motion.
    animationName: stylex.keyframes({
      "0%": { opacity: 1 },
      "50%": { opacity: 0.35 },
      "100%": { opacity: 1 },
    }),
    animationDuration: { default: "1.6s", [media.reduced]: "0s" },
    animationIterationCount: "infinite",
  },
  reference: { width: "min(100%, 18rem)" },
});

/** How a reason carries its reference: `withReference` in @grasp-os/shared/errors. */
const referenced = /^(?<sentence>[\s\S]*?)\s*Reference: (?<reference>\S+)$/u;

/**
 * A failure's words and its reference apart: the sentence to read, and the
 * request id to copy for support, where core gave one.
 */
export const splitReference = (
  reason: string
): { sentence: string; reference?: string } => {
  const found = referenced.exec(reason)?.groups;
  if (found?.sentence === undefined || found.reference === undefined) {
    return { sentence: reason };
  }
  return { sentence: found.sentence, reference: found.reference };
};

const noWatching = () => () => {
  // Nothing to stop.
};

/**
 * Whether Grasp can be reached, as the tab's connection finds it, kept
 * current; none where the page has no connection to ask (a stand-in in a
 * test), so no line is said that isn't known.
 */
export const useCoreReach = (): CoreReach | undefined => {
  // Read as what it may be: a router with no context, or a test's
  // stand-in, has none to ask.
  const context:
    | {
        core?: Partial<Pick<CoreConnection, "reach" | "watchReach">>;
      }
    | undefined = useRouter().options.context;
  const core = context?.core ?? {};
  const known = typeof core.watchReach === "function";
  return useSyncExternalStore(
    (changed) => core.watchReach?.(changed) ?? noWatching(),
    () => (known ? core.reach : undefined)
  );
};

/** The level of the page's heading: `h1` where it stands for the page. */
export type FailedHeading = "h1" | "h2" | "h3";

export interface PageFailedProps {
  /** What failed, as its heading: "This page didn't load". */
  title: string;
  /** Why, in one plain sentence, with its reference if core gave one (split off to copy). */
  reason?: string;
  /** The heading's level. @default "h1" */
  heading?: FailedHeading;
  /** The whole window, when the shell itself could not load. @default false */
  whole?: boolean;
  /** Asks again: what failed is read again; resolves once it was. */
  onRetry: () => Promise<void> | void;
  /** A quiet way on beside Try again: Go to Chat, Fix with Grasp. */
  wayOn?: ReactNode;
  /** Whether Grasp can be reached; the line is left out without it. */
  reach?: CoreReach;
  /** Anything under it, folded: a frame's technical details. */
  children?: ReactNode;
}

/** A page that failed, on Grasp UI's pattern (see the file's head). */
export const PageFailed = ({
  title,
  reason,
  heading: Heading = "h1",
  whole = false,
  onRetry,
  wayOn,
  reach,
  children,
}: PageFailedProps) => {
  const { t } = useLingui();
  const { sentence, reference } =
    reason === undefined ? { sentence: undefined } : splitReference(reason);
  // Said once, as it appears: why it failed (the heading is read with the
  // page), as an alert, as every failure is.
  const said = sentence === undefined || sentence === "" ? title : sentence;
  const retry = useAction(
    async () => {
      await onRetry();
    },
    { working: t`Trying again…`, done: t`Loaded`, failed: t`Could not load` }
  );
  const facts: Record<CoreReach, string> = {
    checking: t`Checking whether Grasp can be reached`,
    // The connection keeps trying by itself: no answer yet, not none ever.
    unreachable: t`No answer from Grasp yet`,
    reachable: t`Grasp can be reached`,
  };
  return (
    <Backdrop
      fadeFoot
      layout={whole ? styles.whole : styles.page}
      variant={{ backdrop: "dusk", pattern: "bayer", tone: "aurora" }}
    >
      <div data-slot="page-failed" {...stylex.props(styles.words)}>
        <Heading {...stylex.props(styles.heading)}>{title}</Heading>
        {sentence === undefined || sentence === "" ? null : (
          <p {...stylex.props(styles.sentence)}>{sentence}</p>
        )}
        <div {...stylex.props(styles.actions)}>
          <Button variant="ink" {...retry.props}>
            {t`Try again`}
          </Button>
          {wayOn}
        </div>
        {reach === undefined ? null : (
          <p {...stylex.props(styles.fact)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.dot, styles[reach])}
            />
            {facts[reach]}
          </p>
        )}
        {reference === undefined ? null : (
          <CopyField
            aria-label={t`Reference for support`}
            copiedLabel={t`Copied`}
            failedLabel={t`Could not copy`}
            layout={styles.reference}
            size="sm"
            value={reference}
          />
        )}
        {children}
      </div>
      <p role="alert" {...stylex.props(visuallyHidden)}>
        {said}
      </p>
    </Backdrop>
  );
};

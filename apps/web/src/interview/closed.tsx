import { interviewerNames } from "@grasp-os/shared/onboarding";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { HoldButton } from "@grasp-os/ui/components/hold-button";
import { Text } from "@grasp-os/ui/components/text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Icon, PlusIcon, TrashIcon } from "@grasp-os/ui/lib/icons";
import { focusRing, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  media,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { SaveTrouble } from "./composer.tsx";
import { WhereLinesGo } from "./destination.tsx";
import { tool } from "./frame.tsx";
import { useInterviewer, useProgress } from "./kept.ts";
import { sayingMs } from "./loop.ts";
import { SpokenText, useSaid } from "./spoken.tsx";

// The end of an interview (prototype `interview-view.tsx`, `Closed`,
// `Rating` and `DeleteInterview`): his thanks, and how long the link still
// works. The one thing to do here is to go back in and add something;
// under it, quietly, how it was to talk to him. Deleting is top right, out
// of the way, and has to be held before it even asks.

const ratings = [1, 2, 3, 4, 5] as const;

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["8"],
    width: "100%",
    maxWidth: "28rem",
    textAlign: "center",
  },
  words: { display: "flex", flexDirection: "column", gap: space["3"] },
  // The one thing to do, and the quiet way to where the lines go under it.
  ways: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["2"],
  },
  // The rating, quiet and on one line where it fits: the question, then five dots.
  rating: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    columnGap: space["2"],
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  dots: { display: "flex", alignItems: "center" },
  dotButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: space["8"],
    height: space["8"],
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.circle,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  dot: {
    width: space["3"],
    height: space["3"],
    borderWidth: sizes.hairline,
    borderStyle: "solid",
    borderRadius: radius.circle,
    borderColor: {
      default: colors.mutedForeground,
      ":is(:hover > *)": colors.foreground,
    },
    transitionProperty: {
      default: "border-color, background-color",
      [media.reducedMotion]: "none",
    },
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  dotOn: { borderColor: colors.foreground, backgroundColor: colors.foreground },
});

/**
 * How it was to talk to Stephen, as five dots to press: theirs to say or
 * to leave, and to change while the link works. Quiet: the question in
 * the body's muted words, the dots after it; each dot names itself.
 */
const Rating = ({
  value,
  onRate,
}: {
  value: number | undefined;
  onRate: (rating: number) => void;
}) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  const question = t`How was talking to ${who}?`;
  return (
    <fieldset {...stylex.props(styles.rating)}>
      <legend {...stylex.props(visuallyHidden)}>{question}</legend>
      <Text aria-live="polite" as="span" color="muted">
        {value === undefined ? question : t`Thank you for telling me.`}
      </Text>
      <span {...stylex.props(styles.dots)}>
        {ratings.map((rating) => {
          const on = value !== undefined && rating <= value;
          return (
            <button
              aria-label={t`${rating} of 5`}
              aria-pressed={value === rating}
              key={rating}
              onClick={() => {
                onRate(rating);
              }}
              type="button"
              {...stylex.props(styles.dotButton, focusRing)}
            >
              <span {...stylex.props(styles.dot, on && styles.dotOn)} />
            </button>
          );
        })}
      </span>
    </fieldset>
  );
};

/** His thanks, and what they can still do: add something, see where their lines go, and say how it was. */
export const Closed = ({
  name,
  closes,
  rating,
  onRate,
  onAdd,
}: {
  name: string;
  /** The last day the link works, in words. */
  closes: string;
  rating: number | undefined;
  onRate: (rating: number) => void;
  onAdd: () => void;
}) => {
  const { t } = useLingui();
  // Lines agreed under what this interview said before can only be moved
  // once they read what it says now: "Add something" takes them there.
  const { told } = useProgress();
  const title = t`Thank you, ${name}.`;
  const message = t`What you agreed to is kept. Forgot something? This link works until ${closes}.`;
  const line = `${title} ${message}`;
  // He says his thanks once, as the screen comes.
  const [saying, setSaying] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setSaying(false);
    }, sayingMs(line));
    return () => {
      window.clearTimeout(id);
    };
  }, [line]);
  const said = useSaid({ line, saying: 1, from: 0, speaking: saying });
  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.words)}>
        <Heading level={1} size="xl">
          <SpokenText said={said} text={title} />
        </Heading>
        <Text aria-live="polite" color="muted">
          <SpokenText from={title.length + 1} said={said} text={message} />
        </Text>
      </div>
      <div {...stylex.props(styles.ways)}>
        <Button onClick={onAdd} size="lg">
          <Icon icon={PlusIcon} />
          {t`Add something`}
        </Button>
        {told ? <WhereLinesGo /> : null}
      </div>
      {/* A change of where a line goes not kept yet, or refused, shows here too once the sheet is closed. */}
      <SaveTrouble />
      <Rating onRate={onRate} value={rating} />
    </div>
  );
};

/** How long "Delete my interview" is held before it asks. */
const holdMs = 4000;

/**
 * The way to delete the interview, top right and quiet on purpose: theirs
 * to do, never something to be invited to. Held for four seconds, filling
 * up as it goes, it asks first, and says what would be lost and what they
 * can do instead.
 */
export const DeleteInterview = ({
  onDelete,
  onWithdraw,
}: {
  onDelete: () => void;
  /** Withdrawing instead, while they still take part. */
  onWithdraw?: () => void;
}) => {
  const { t } = useLingui();
  const [asking, setAsking] = useState(false);
  return (
    <>
      {/* One of the header's tools, as quiet as the rest: an icon, named on a pause. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <HoldButton
            aria-label={t`Delete my interview`}
            duration={holdMs}
            onConfirm={() => {
              setAsking(true);
            }}
            size={tool.button}
            variant="ghost"
          >
            <Icon icon={TrashIcon} />
          </HoldButton>
        </TooltipTrigger>
        <TooltipContent>{t`Delete my interview`}</TooltipContent>
      </Tooltip>
      <AlertDialog onOpenChange={setAsking} open={asking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Delete your interview?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Everything you told me is removed for good and cannot be brought back. Is only something wrong? Then put it right with “Add something” instead.`}
            </AlertDialogDescription>
            {onWithdraw === undefined ? null : (
              <AlertDialogDescription>
                {t`Or withdraw: nothing you said is used from now on, and you can still read it here.`}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Keep my interview`}</AlertDialogCancel>
            {onWithdraw === undefined ? null : (
              <AlertDialogAction onClick={onWithdraw} variant="outline">
                {t`Withdraw instead`}
              </AlertDialogAction>
            )}
            <AlertDialogAction onClick={onDelete} variant="destructive">
              <Icon icon={TrashIcon} />
              {t`Delete it`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

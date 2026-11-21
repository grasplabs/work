import { interviewerNames } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Button } from "../grasp/button/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Plus, Trash } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { SaveTrouble } from "./composer.tsx";
import { WhereLinesGo } from "./destination.tsx";
import { Head, headSizes, useHead } from "./head.tsx";
import { useInterviewer, useProgress } from "./kept.ts";
import { sayingMs } from "./loop.ts";
import { SpokenText, useSaid } from "./spoken.tsx";
import { usePromise } from "./words.ts";

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
    gap: grasp.space6,
    width: "100%",
    maxWidth: "28rem",
    textAlign: "center",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space6,
    width: "100%",
  },
  words: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  // What he says under the title, as the muted body text, in balanced lines.
  message: {
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    textWrap: "balance",
  },
  add: { width: "100%", maxWidth: "24rem" },
  // The rating: the question over a row of five dots, named at both ends.
  rating: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  legend: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  scale: { display: "flex", alignItems: "center", gap: grasp.space2 },
  end: { fontSize: grasp.textXs, lineHeight: grasp.textXsLine },
  dots: { display: "flex", alignItems: "center" },
  dotButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.space8,
    height: grasp.space8,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  dot: {
    width: grasp.space3,
    height: grasp.space3,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderRadius: grasp.cornerCircle,
    borderColor: {
      default: grasp.muted,
      ":is(:hover > *)": grasp.ink,
    },
    transitionProperty: {
      default: "border-color, background-color",
      [media.reduced]: "none",
    },
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  dotOn: { borderColor: grasp.ink, backgroundColor: grasp.ink },
});

/**
 * How it was to talk to Stephen, as five dots to press: theirs to say or
 * to leave, and to change while the link works.
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
      <legend {...stylex.props(styles.legend)}>{question}</legend>
      <span aria-live="polite">
        {value === undefined ? question : t`Thank you for telling me.`}
      </span>
      <div {...stylex.props(styles.scale)}>
        <span aria-hidden="true" {...stylex.props(styles.end)}>
          {t({
            message: "Not good",
            context: "lowest end of a rating of the interview",
          })}
        </span>
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
                {...stylex.props(styles.dotButton, focus.ring)}
              >
                <span {...stylex.props(styles.dot, on && styles.dotOn)} />
              </button>
            );
          })}
        </span>
        <span aria-hidden="true" {...stylex.props(styles.end)}>
          {t({
            message: "Very good",
            context: "highest end of a rating of the interview",
          })}
        </span>
      </div>
    </fieldset>
  );
};

/** His thanks, and what they can still do: add something, and say how it was. */
export const Closed = ({
  room,
  name,
  closes,
  rating,
  onRate,
  onAdd,
}: {
  room: number;
  name: string;
  /** The last day the link works, in words. */
  closes: string;
  rating: number | undefined;
  onRate: (rating: number) => void;
  onAdd: () => void;
}) => {
  const { t } = useLingui();
  const interviewer = useInterviewer();
  const who = interviewerNames[interviewer];
  const promise = usePromise();
  // Lines agreed under what this interview said before can only be moved
  // once they read what it says now: "Add something" takes them there.
  const { told } = useProgress();
  const title = t`Thank you, ${name}.`;
  const message = t`What you agreed to is kept. Forgot something? This link works until ${closes}.`;
  const line = `${title} ${message}`;
  const { body, size } = useHead(room, headSizes.talking);
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
      <Head
        fill={1}
        label={t`${who}, drawn in dots.`}
        sign="heart"
        size={size}
        who={interviewer}
      />
      <div {...stylex.props(styles.body)} ref={body}>
        <div {...stylex.props(styles.words)}>
          <Heading level={1}>
            <SpokenText said={said} text={title} />
          </Heading>
          <p aria-live="polite" {...stylex.props(styles.message)}>
            <SpokenText from={title.length + 1} said={said} text={message} />
          </p>
        </div>
        <Button
          icon={Plus}
          layout={styles.add}
          onClick={onAdd}
          size="lg"
          variant="ink"
        >
          {t`Add something`}
        </Button>
        {told ? <WhereLinesGo /> : null}
        {/* A change of where a line goes not kept yet, or refused, shows here too once the sheet is closed. */}
        <SaveTrouble />
        <Rating onRate={onRate} value={rating} />
        <Text size="xs" tone="muted">
          {promise}
        </Text>
      </div>
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
      <Button
        hold={{ ms: holdMs }}
        onClick={() => {
          setAsking(true);
        }}
        size="xs"
        variant="ghost"
      >
        {t`Delete my interview`}
      </Button>
      <AlertDialog onOpenChange={setAsking} open={asking}>
        <AlertDialogContent>
          <AlertDialogTitle>{t`Delete your interview?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Everything you told me is removed for good and cannot be brought back. Is only something wrong? Then put it right with “Add something” instead.`}
          </AlertDialogDescription>
          {onWithdraw === undefined ? null : (
            <AlertDialogDescription>
              {t`Or withdraw: nothing you said is used from now on, and you can still read it here.`}
            </AlertDialogDescription>
          )}
          <AlertDialogFooter>
            <AlertDialogAction>{t`Keep my interview`}</AlertDialogAction>
            {onWithdraw === undefined ? null : (
              <AlertDialogAction action={onWithdraw} variant="quiet">
                {t`Withdraw instead`}
              </AlertDialogAction>
            )}
            <AlertDialogAction action={onDelete} icon={Trash} variant="danger">
              {t`Delete it`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

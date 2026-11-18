import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Backdrop, BackdropGlass } from "../grasp/backdrop/index.ts";
import type { BackdropLook } from "../grasp/backdrop/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../grasp/tooltip/index.ts";

// The card on top of the dashboard's pile (`todo-pile.tsx`), as the
// prototype draws it (`components/dashboard/todo-stack.tsx`): as little
// on it as it takes to decide, close together in its middle. A line that
// says it waits on the reader, so nobody takes it for news; its name; what
// has to be read before deciding, where there is any; right under that its
// yes and its no, side by side, the same on every card and in the same
// places; the pile puts where in it the card is, its arrows and Skip in
// the card's top corners. What a button does is said when the pointer
// rests on it, and nowhere else.

/** The pile's own width from which its corners stand beside the card's name rather than over it. */
const WIDE = "@container (width >= 48rem)";

/**
 * The painting the card stands on: the painted field's "dawn" in "columns"
 * as the library's dither has it, in mint on a grid, still, so it reads
 * at once and in both schemes.
 */
const painting: BackdropLook = {
  backdrop: "dusk",
  pattern: "grid",
  tone: "mint",
};

const styles = stylex.create({
  // The card: the painting to its corners, lifted as a card is (grasp/card).
  card: {
    display: "block",
    minWidth: 0,
    margin: 0,
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.liftMedium,
  },
  // Room on the painting round the glass, and over it for the pile's corners: less where they
  // stand beside the name.
  painting: {
    display: "flex",
    flexDirection: "column",
    padding: {
      default: `${grasp.space12} ${grasp.space4} ${grasp.space4}`,
      [WIDE]: `${grasp.space8} ${grasp.space4} ${grasp.space4}`,
    },
  },
  glass: {
    minWidth: 0,
    padding: grasp.space6,
  },
  inside: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space5,
    minWidth: 0,
    textAlign: "center",
  },
  head: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  name: {
    maxWidth: grasp.frameColumn,
  },
  details: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    width: "100%",
    maxWidth: grasp.frameMeasure,
    minWidth: 0,
    textAlign: "start",
  },
  answers: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  buttons: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  // The yes and the no each as wide as the other, so they stand in the same places on every card.
  answer: {
    minWidth: `calc(${grasp.space24} + ${grasp.space4})`,
  },
});

/** What the pile gives the card on top. */
export interface Pile {
  /**
   * Says a press is meant for this card, and the pile notes that a card
   * may leave; false for one that comes too soon after the last card came
   * up, the second of a double press meant for the card before. `keys`:
   * the keys go on with the next card, as for a press made in a dialog
   * the card opened, which stands outside the card.
   */
  answering: (keys?: boolean) => boolean;
  /** Says the answer the card gave is through, however it went. */
  settled: () => void;
  /**
   * Whether an answer this card gave is still on its way: kept by the
   * pile, so it holds while the card is turned away from and back to.
   */
  deciding: boolean;
  /** Says what was done, for a screen reader: the pile itself only shows the next card. */
  answered: (said: string) => void;
}

/** One of a card's two buttons. */
export interface Answer {
  /** The word on the button. */
  label: string;
  /** Its name: the word, with what it answers. */
  name: string;
  /** What it does, in a sentence. */
  does: string;
  /** Resolves once the answer is through, however it went. */
  onPress: () => Promise<void> | void;
  disabled?: boolean;
  /** The id of a line that says why it waits. */
  describedBy?: string;
  /**
   * Asked once more before it is done, in an alert dialog: for an answer
   * that can't be taken back. Its button warns (`danger`) unless `variant`
   * says otherwise.
   */
  confirm?: {
    title: string;
    description: string;
    variant?: "ink" | "danger";
  };
}

/** How long the pointer rests on a button before what it does is said, in milliseconds: someone who presses at once is told nothing. */
const rests = 450;

/** A button of the card, with what it does said when the pointer rests on it. */
const AnswerButton = ({
  answer,
  busy,
  pile,
  first = false,
  variant,
}: {
  answer: Answer;
  busy: boolean;
  pile: Pile;
  first?: boolean;
  variant: "approve" | "quiet";
}) => {
  const { t } = useLingui();
  const press = async (keys?: boolean): Promise<void> => {
    if (!pile.answering(keys)) {
      return;
    }
    try {
      await answer.onPress();
    } catch (error) {
      pile.settled();
      throw error;
    }
    pile.settled();
  };
  const disabled = busy || answer.disabled === true;
  const marked = first ? "" : undefined;
  const { confirm } = answer;
  if (confirm !== undefined) {
    return (
      <AlertDialog>
        <AlertDialogTrigger
          aria-describedby={answer.describedBy}
          aria-label={answer.name}
          data-first={marked}
          disabled={disabled}
          layout={styles.answer}
          size="lg"
          variant={variant}
        >
          {answer.label}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                // Pressed in the dialog, outside the card: the keys go on
                // with the next card all the same.
                void press(true);
              }}
              variant={confirm.variant ?? "danger"}
            >
              {answer.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  if (disabled) {
    // Out of use: nothing to press, so nothing to say it does; the line it
    // points at says why it waits.
    return (
      <Button
        aria-describedby={answer.describedBy}
        aria-label={answer.name}
        data-first={marked}
        disabled
        layout={styles.answer}
        size="lg"
        variant={variant}
      >
        {answer.label}
      </Button>
    );
  }
  return (
    <Tooltip delay={rests}>
      <TooltipTrigger
        aria-label={answer.name}
        data-first={marked}
        layout={styles.answer}
        onClick={() => {
          void press();
        }}
        size="lg"
        variant={variant}
      >
        {answer.label}
      </TooltipTrigger>
      <TooltipContent side={first ? "left" : "right"}>
        {answer.does}
      </TooltipContent>
    </Tooltip>
  );
};

/** The card on top of the pile, named by its name. */
export const PileCard = ({
  pile,
  name,
  details,
  yes,
  no,
  busy,
  failure,
}: {
  pile: Pile;
  name: ReactNode;
  /** What has to be read before deciding. */
  details?: ReactNode;
  yes: Answer;
  no: Answer;
  busy: boolean;
  failure: string | undefined;
}) => {
  const nameId = useId();
  return (
    // The one thing on the dashboard that waits on someone, so it stands on
    // a painting, its words on the glass over it.
    <article aria-labelledby={nameId} {...stylex.props(styles.card)}>
      <Backdrop layout={styles.painting} variant={painting}>
        <BackdropGlass layout={styles.glass}>
          <div {...stylex.props(styles.inside)}>
            <div {...stylex.props(styles.head)}>
              {/* The mark of what needs someone: it waits on the reader. */}
              <Badge tone="attention" variant="dot">
                <Trans>Waiting on you</Trans>
              </Badge>
              <Heading id={nameId} layout={styles.name} level={2} size="md">
                {name}
              </Heading>
            </div>
            {details === undefined ? null : (
              <div {...stylex.props(styles.details)}>{details}</div>
            )}
            <div {...stylex.props(styles.answers)}>
              <div {...stylex.props(styles.buttons)}>
                <AnswerButton
                  answer={yes}
                  busy={busy || pile.deciding}
                  first
                  pile={pile}
                  variant="approve"
                />
                <AnswerButton
                  answer={no}
                  busy={busy || pile.deciding}
                  pile={pile}
                  variant="quiet"
                />
              </div>
              {failure === undefined ? null : (
                <Alert variant="danger">{failure}</Alert>
              )}
            </div>
          </div>
        </BackdropGlass>
      </Backdrop>
    </article>
  );
};

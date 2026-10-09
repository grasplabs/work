import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";

// The card on top of the dashboard's pile (`todo-pile.tsx`), as the
// prototype draws it (`components/dashboard/todo-stack.tsx`): as little
// on it as it takes to decide, close together in its middle. A line that
// says it waits on the reader, so nobody takes it for news; its name; what
// has to be read before deciding, where there is any; right under that its
// yes and its no, side by side, the same on every card and in the same
// places; the pile puts where in it the card is, its arrows and Skip in
// the card's top corners. What a button does is said when the pointer
// rests on it, and nowhere else.

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
  /** Asked once more before it is done, in a dialog: for a no that can't be taken back. */
  confirm?: { title: string; description: string };
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
  variant: "default" | "outline";
}) => {
  const [confirming, setConfirming] = useState(false);
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
  const button = (
    <Button
      aria-describedby={answer.describedBy}
      aria-label={answer.name}
      className="min-w-28"
      data-first={first ? "" : undefined}
      disabled={busy || answer.disabled === true}
      onClick={
        answer.confirm === undefined
          ? () => {
              void press();
            }
          : undefined
      }
      size="lg"
      variant={variant}
    />
  );
  const { confirm } = answer;
  if (confirm === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger delay={rests} render={button}>
          {answer.label}
        </TooltipTrigger>
        <TooltipContent side={first ? "left" : "right"} sideOffset={10}>
          {answer.does}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Dialog onOpenChange={setConfirming} open={confirming}>
      <DialogTrigger render={button}>{answer.label}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirm.title}</DialogTitle>
          <DialogDescription>{confirm.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              // Pressed in the dialog, outside the card: the keys go on
              // with the next card all the same.
              void press(true);
            }}
            variant="destructive"
          >
            {answer.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <article
      aria-labelledby={nameId}
      className="bg-card relative flex min-w-0 flex-col items-center gap-5 overflow-hidden rounded-xl border px-6 pt-14 pb-8 text-center text-sm"
    >
      {/* The brand's Columns pattern, in the app's greys: the card is never an empty white field. */}
      <span
        aria-hidden="true"
        className="field-columns pointer-events-none absolute inset-0"
      />
      <div className="relative flex flex-col items-center gap-2">
        <p className="text-muted-foreground flex items-center gap-2">
          {/* The mark of what needs someone beats, as something that waits does; still for whoever asks for less motion. */}
          <span aria-hidden="true" className="relative flex size-1.5 flex-none">
            <span className="bg-status-attention absolute inset-0 rounded-full motion-safe:animate-ping" />
            <span className="bg-status-attention relative size-1.5 rounded-full" />
          </span>
          <Trans>Waiting on you</Trans>
        </p>
        <h2
          className="max-w-3xl text-2xl font-medium tracking-tight text-balance break-words"
          id={nameId}
        >
          {name}
        </h2>
      </div>
      {details === undefined ? null : (
        <div className="relative flex w-full max-w-2xl min-w-0 flex-col gap-3 text-left">
          {details}
        </div>
      )}
      <div className="relative flex min-w-0 flex-col items-center gap-2">
        {/* The yes and the no side by side, each as wide as the other, so they stand in the same places on every card. */}
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-2">
          <AnswerButton
            answer={yes}
            busy={busy || pile.deciding}
            first
            pile={pile}
            variant="default"
          />
          <AnswerButton
            answer={no}
            busy={busy || pile.deciding}
            pile={pile}
            variant="outline"
          />
        </div>
        <ErrorText>{failure}</ErrorText>
      </div>
    </article>
  );
};

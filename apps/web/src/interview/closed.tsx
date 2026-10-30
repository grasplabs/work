import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Head, headSizes, useHead } from "./head.tsx";
import { useInterviewer } from "./kept.ts";
import { sayingMs } from "./loop.ts";
import { SpokenText, useSaid } from "./spoken.tsx";
import { usePromise } from "./words.ts";

// The end of an interview (prototype `interview-view.tsx`, `Closed`,
// `Rating` and `DeleteInterview`): his thanks, and how long the link still
// works. The one thing to do here is to go back in and add something;
// under it, quietly, how it was to talk to him. Deleting is top right, out
// of the way, and has to be held before it even asks.

const ratings = [1, 2, 3, 4, 5] as const;

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
    <fieldset className="text-muted-foreground flex flex-col items-center gap-1.5 text-sm">
      <legend className="sr-only">{question}</legend>
      <span aria-live="polite">
        {value === undefined ? question : t`Thank you for telling me.`}
      </span>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-xs">
          {t({
            message: "Not good",
            context: "lowest end of a rating of the interview",
          })}
        </span>
        <span className="flex items-center">
          {ratings.map((rating) => {
            const on = value !== undefined && rating <= value;
            return (
              <button
                aria-label={t`${rating} of 5`}
                aria-pressed={value === rating}
                className="group focus-visible:ring-ring/50 flex size-8 items-center justify-center rounded-full outline-none focus-visible:ring-3"
                key={rating}
                onClick={() => {
                  onRate(rating);
                }}
                type="button"
              >
                <span
                  className={cn(
                    "size-3 rounded-full border transition-colors",
                    on
                      ? "border-foreground bg-foreground"
                      : "border-muted-foreground group-hover:border-foreground"
                  )}
                />
              </button>
            );
          })}
        </span>
        <span aria-hidden="true" className="text-xs">
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
    <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
      <Head
        fill={1}
        label={t`${who}, drawn in dots.`}
        sign="heart"
        size={size}
        who={interviewer}
      />
      <div className="flex w-full flex-col items-center gap-6" ref={body}>
        <div className="flex flex-col gap-2">
          <h1 className="type-title">
            <SpokenText said={said} text={title} />
          </h1>
          <p aria-live="polite" className="text-muted-foreground text-balance">
            <SpokenText from={title.length + 1} said={said} text={message} />
          </p>
        </div>
        <Button
          className="w-full max-w-sm"
          onClick={onAdd}
          size="xl"
          variant="highlight"
        >
          <PlusIcon data-icon="inline-start" />
          {t`Add something`}
        </Button>
        <Rating onRate={onRate} value={rating} />
        <p className="text-muted-foreground text-xs text-balance">{promise}</p>
      </div>
    </div>
  );
};

/** How long "Delete my interview" is held before it even asks. */
const holdMs = 4000;
/** How long the hint that it has to be held stays. */
const hintMs = 2600;

/**
 * The way to delete the interview, top right and quiet on purpose: theirs
 * to do, never something to be invited to. A press only says that it has
 * to be held; held for four seconds, filling up as it goes, it asks first,
 * and says what would be lost and what they can do instead.
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
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);
  const [asking, setAsking] = useState(false);
  const held = useRef(0);
  const hinted = useRef(0);
  useEffect(
    () => () => {
      window.clearTimeout(held.current);
      window.clearTimeout(hinted.current);
    },
    []
  );
  const hold = (): void => {
    if (holding) {
      return;
    }
    window.clearTimeout(hinted.current);
    setHint(false);
    setHolding(true);
    held.current = window.setTimeout(() => {
      setHolding(false);
      setAsking(true);
    }, holdMs);
  };
  const letGo = (): void => {
    if (!holding) {
      return;
    }
    window.clearTimeout(held.current);
    setHolding(false);
    setHint(true);
    hinted.current = window.setTimeout(() => {
      setHint(false);
    }, hintMs);
  };
  let words = t`Delete my interview`;
  if (holding) {
    words = t`Keep holding`;
  } else if (hint) {
    words = t`Hold for 4 seconds`;
  }
  return (
    <>
      <button
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 relative touch-none overflow-hidden rounded-md px-2.5 py-1.5 text-xs outline-none select-none focus-visible:ring-3"
        onBlur={letGo}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
            event.preventDefault();
            hold();
          }
        }}
        onKeyUp={letGo}
        onPointerCancel={letGo}
        onPointerDown={hold}
        onPointerLeave={letGo}
        onPointerUp={letGo}
        title={t`Hold for 4 seconds`}
        type="button"
      >
        {/* The hold, filling up from the left: let go before it is full and nothing happens. */}
        <span
          aria-hidden="true"
          className={cn(
            "bg-destructive/10 absolute inset-0 origin-left transition-transform",
            holding
              ? "scale-x-100 duration-4000 ease-linear"
              : "scale-x-0 duration-200"
          )}
        />
        <span aria-live="polite" className="relative">
          {words}
        </span>
      </button>
      <Dialog onOpenChange={setAsking} open={asking}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t`Delete your interview?`}</DialogTitle>
            <DialogDescription>
              {t`Everything you told me is removed for good and cannot be brought back. Is only something wrong? Then put it right with “Add something” instead.`}
            </DialogDescription>
            {onWithdraw === undefined ? null : (
              <DialogDescription>
                {t`Or withdraw: nothing you said is used from now on, and you can still read it here.`}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                setAsking(false);
                onDelete();
              }}
              variant="destructive"
            >
              <Trash2Icon data-icon="inline-start" />
              {t`Delete it`}
            </Button>
            {onWithdraw === undefined ? null : (
              <Button
                onClick={() => {
                  setAsking(false);
                  onWithdraw();
                }}
                variant="outline"
              >
                {t`Withdraw instead`}
              </Button>
            )}
            <DialogClose autoFocus render={<Button />}>
              {t`Keep my interview`}
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

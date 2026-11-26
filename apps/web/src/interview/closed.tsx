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
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { SaveTrouble } from "./composer.tsx";
import { tool } from "./frame.tsx";
import { sayingMs } from "./loop.ts";
import { Rating } from "./rating.tsx";
import { SpokenText, useSaid } from "./spoken.tsx";

// The end of an interview (prototype `interview-view.tsx`, `Closed`,
// `Rating` and `DeleteInterview`): his thanks, and how long the link still
// works. The one thing to do here is to go back in and add something;
// under it, quietly, how it was to talk to him. Deleting is top right, out
// of the way, and has to be held before it even asks.

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
  // Balanced, so the date never wraps alone onto a line of its own.
  words: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    textWrap: "balance",
  },
});

/** His thanks, and what they can still do: add something, and say how it was. */
export const Closed = ({
  name,
  closes,
  rating,
  feedback,
  onRate,
  onFeedback,
  onAdd,
}: {
  name: string;
  /** The last day the link works, in words. */
  closes: string;
  rating: number | undefined;
  feedback: string | undefined;
  onRate: (rating: number) => void;
  onFeedback: (feedback: string) => void;
  onAdd: () => void;
}) => {
  const { t } = useLingui();
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
      {/* Where their lines go was said when they started: not again here. */}
      <Button onClick={onAdd} size="lg">
        <Icon icon={PlusIcon} />
        {t`Add something`}
      </Button>
      {/* A rating or their words not kept, or refused, shows here too. */}
      <SaveTrouble />
      <Rating
        feedback={feedback}
        onFeedback={onFeedback}
        onRate={onRate}
        value={rating}
      />
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

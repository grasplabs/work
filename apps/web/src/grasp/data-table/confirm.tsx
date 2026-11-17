// The Alert dialog a grave action asks in before it is done to the chosen rows.
"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../alert-dialog";
import type { DataTableAction } from "./types";
import type { DataTableWords } from "./words";

interface ConfirmProps {
  /** The action asking, or `null` while none is. */
  asking: DataTableAction | null;
  /** How many rows it would be done to, and what they are called. */
  count: number;
  unit: string;
  words: DataTableWords;
  /** Called with the answer, once the dialog closes. */
  onAnswer: (yes: boolean) => void;
}

/** The action's own question: its fixed words, or its words for this many rows. */
const questionOf = (action: DataTableAction, count: number) =>
  typeof action.confirm === "function" ? action.confirm(count) : action.confirm;

export const Confirm = ({
  asking,
  count,
  unit,
  words,
  onAnswer,
}: ConfirmProps) => (
  <AlertDialog
    open={asking !== null}
    onOpenChange={(next, details) => {
      if (!next) {
        onAnswer(details.returnValue === "confirm");
      }
    }}
  >
    {asking !== null && (
      <AlertDialogContent>
        <AlertDialogTitle>
          {questionOf(asking, count)?.title ??
            words.confirm(asking.label, count, unit)}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {questionOf(asking, count)?.description ?? words.confirmDetail}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{words.cancel}</AlertDialogAction>
          <AlertDialogAction variant="danger" value="confirm">
            {asking.label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    )}
  </AlertDialog>
);

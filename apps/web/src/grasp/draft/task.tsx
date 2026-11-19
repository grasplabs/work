// TaskDraft: a to-do or a reminder the agent drafted ("remind me to chase Kestrel on Friday"), on the
// Draft frame: its name in the head, then when it is due, who does it (people's chips), and a note,
// then Add task. The name, the due moment and the note change in place; a person can be taken off.
// The host gets every change (`onDraftChange`) and the task as it stands on Add task (`onAdd`).
//
//   <TaskDraft draft={task} onDraftChange={setTask} onAdd={add} onDismiss={dismiss} timeZone="Europe/Amsterdam" />
"use client";

import type { ReactNode } from "react";

import { Checklist, Clock, Note, People } from "../icons";
import {
  changeOf,
  Draft,
  draftEditable,
  draftKeys,
  DraftInput,
  withoutAt,
  DraftPersonChip,
  DraftRow,
  DraftText,
  fieldOf,
  filled,
  useDraftWords,
} from "./draft";
import type { DraftPerson, DraftStatus } from "./draft";
import { DraftDue, isDay } from "./when";
import type { DraftWords } from "./words";

/** The task as drafted. */
export interface TaskDraftValue {
  title: string;
  /**
   * When it is due: a moment, as an ISO time with its offset ("2026-11-20T17:00:00+01:00"), or a day
   * with no time, as its date alone ("2026-11-20"), shown and read as that day in every zone. Left
   * out, it has no date.
   */
  due?: string;
  people: readonly DraftPerson[];
  note?: string;
}

/** Every prop a TaskDraft takes. */
export interface TaskDraftProps {
  /** Where the draft is (Draft's `status`): drafting, ready, sending, sent, failed or dismissed. */
  status?: DraftStatus;
  /** When it was added, ISO, for the sent line's time. */
  doneAt?: string;
  /** Undo on the sent line, for as long as the host can undo. */
  onUndo?: () => void;
  /** Restore on the dismissed line, for as long as the host can bring it back. */
  onRestore?: () => void;
  /** The task as it stands. */
  draft: TaskDraftValue;
  /** Every change the person makes in place; left out, the draft is locked, as `readOnly`. */
  onDraftChange?: (draft: TaskDraftValue) => void;
  /**
   * Locked: shown to be made exactly as it is. No way to change it, no remove on a chip, no
   * placeholder and no empty optional row; its values stand as text, and the foot keeps its main
   * action and Discard. Leaving out `onDraftChange` locks it the same way.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Holds the main action back until the host clears it, with the reason ("Read the whole email
   * first"), as ApprovalRequest's `approveHeld`: out of use but still reached by Tab, the reason
   * beside it and said with it. Discard stays usable.
   */
  mainHeld?: string;
  /** Add task: the task as it stands. Return a Promise and the button works until it settles. */
  onAdd: (draft: TaskDraftValue) => unknown;
  /** Discard, at the foot's start. */
  onDismiss?: () => void;
  /** The task service's mark in the head (a BrandIcon); left out, the task icon. */
  mark?: ReactNode;
  /** The zone its times are shown in; left out, the browser's. */
  timeZone?: string;
}

/** The due row's words: a day alone, a day and its time, or the way to add one. */
const dueWords = (
  words: DraftWords["task"],
  due: string | undefined,
  timeZone: string | undefined
) => {
  if (due === undefined) {
    return words.addDue;
  }
  return isDay(due) ? words.on(due) : words.at(due, timeZone);
};

/** A task drafted in an answer, ready to change and add. */
export const TaskDraft = ({
  draft,
  onDraftChange,
  readOnly,
  mainHeld,
  onAdd,
  onDismiss,
  mark,
  timeZone,
  status = "ready",
  doneAt,
  onUndo,
  onRestore,
}: TaskDraftProps) => {
  const words = useDraftWords("task");
  const change = changeOf(readOnly, onDraftChange);
  const locked = change === undefined;
  // Fields change only while it can still be changed: ready, or failed and to be sent again.
  const field = fieldOf(draft, change, status);
  const people = field("people");
  const due = field("due");
  const keys = draftKeys(draft.people);
  const shown = dueWords(words, draft.due, timeZone);
  return (
    <Draft
      aria-label={`${words.kind}: ${draft.title}`}
      icon={Checklist}
      mark={mark}
      title={
        <DraftInput
          readOnly={locked}
          title
          value={draft.title}
          label={words.title}
          placeholder={locked ? undefined : words.title}
          onValueChange={field("title")}
        />
      }
      mainHeld={mainHeld}
      main={{ label: words.add, onPress: () => onAdd(draft) }}
      onDismiss={onDismiss}
      status={status}
      done={
        doneAt === undefined
          ? words.added
          : `${words.added} · ${words.time(doneAt, timeZone)}`
      }
      onUndo={onUndo}
      onRestore={onRestore}
      readOnly={locked}
    >
      {locked && draft.due === undefined ? null : (
        <DraftRow icon={Clock} label={words.due}>
          {due !== undefined && draftEditable(status) ? (
            <DraftDue at={draft.due} words={shown} onChange={due} />
          ) : (
            <time dateTime={draft.due}>{shown}</time>
          )}
        </DraftRow>
      )}
      {locked && draft.people.length === 0 ? null : (
        <DraftRow icon={People} label={words.people}>
          {draft.people.map((person, index) => (
            <DraftPersonChip
              whole={locked}
              key={keys[index]}
              person={person}
              onRemove={
                people === undefined || person.you === true
                  ? undefined
                  : () => {
                      people(withoutAt(draft.people, index));
                    }
              }
            />
          ))}
        </DraftRow>
      )}
      {locked && !filled(draft.note) ? null : (
        <DraftRow icon={Note} label={words.note}>
          <DraftText
            readOnly={locked}
            value={draft.note ?? ""}
            label={words.note}
            placeholder={locked ? undefined : words.addNote}
            onValueChange={field("note")}
          />
        </DraftRow>
      )}
    </Draft>
  );
};

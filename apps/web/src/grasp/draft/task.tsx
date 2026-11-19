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
  Draft,
  draftEditable,
  DraftInput,
  DraftPersonChip,
  DraftRow,
  DraftText,
  fieldOf,
  useDraftWords,
} from "./draft";
import type { DraftPerson, DraftStatus } from "./draft";
import { DraftDue } from "./when";

/** The task as drafted. `due` is an ISO time with its offset; left out, it has no date. */
export interface TaskDraftValue {
  title: string;
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
  /** Every change the person makes in place; left out, the draft is read only. */
  onDraftChange?: (draft: TaskDraftValue) => void;
  /** Add task: the task as it stands. Return a Promise and the button works until it settles. */
  onAdd: (draft: TaskDraftValue) => unknown;
  /** Discard, at the foot's start. */
  onDismiss?: () => void;
  /** The task service's mark in the head (a BrandIcon); left out, the task icon. */
  mark?: ReactNode;
  /** The zone its times are shown in; left out, the browser's. */
  timeZone?: string;
}

/** A task drafted in an answer, ready to change and add. */
export const TaskDraft = ({
  draft,
  onDraftChange,
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
  // Fields change only while it can still be changed: ready, or failed and to be sent again.
  const field = fieldOf(draft, onDraftChange, status);
  const people = field("people");
  const due = field("due");
  const shown =
    draft.due === undefined ? words.addDue : words.at(draft.due, timeZone);
  return (
    <Draft
      aria-label={`${words.kind}: ${draft.title}`}
      icon={Checklist}
      mark={mark}
      title={
        <DraftInput
          title
          value={draft.title}
          label={words.title}
          placeholder={words.title}
          onValueChange={field("title")}
        />
      }
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
    >
      <DraftRow icon={Clock} label={words.due}>
        {due !== undefined && draftEditable(status) ? (
          <DraftDue at={draft.due} words={shown} onChange={due} />
        ) : (
          <span>{shown}</span>
        )}
      </DraftRow>
      <DraftRow icon={People} label={words.people}>
        {draft.people.map((person) => (
          <DraftPersonChip
            key={person.email ?? person.name}
            person={person}
            onRemove={
              people === undefined || person.you === true
                ? undefined
                : () => {
                    people(draft.people.filter((other) => other !== person));
                  }
            }
          />
        ))}
      </DraftRow>
      <DraftRow icon={Note} label={words.note}>
        <DraftText
          value={draft.note ?? ""}
          label={words.note}
          placeholder={words.addNote}
          onValueChange={field("note")}
        />
      </DraftRow>
    </Draft>
  );
};

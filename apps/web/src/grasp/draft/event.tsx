// EventDraft: an event the agent drafted ("put a meeting with Jerry in my agenda tomorrow at two"),
// on the Draft frame. The day around it (everyone's busy time, the event across their lanes, and
// "Conflicts" where it meets someone's), then the when, the people, the call, the place and the
// description, then Create event. The title, the place and the description change in place; a
// person can be taken off. The host gets every change (`onDraftChange`) and the draft as it stands
// on Create (`onCreate`).
//
//   <EventDraft draft={event} onDraftChange={setEvent} onCreate={create} onDismiss={dismiss} timeZone="Europe/Amsterdam" />
"use client";

import type { ReactNode } from "react";

import { Button } from "../button";
import { CalendarIcon, Clock, Note, People, Place, VideoCall } from "../icons";
import { DraftDay } from "./day";
import type { DraftBusy } from "./day";
import {
  Draft,
  draftEditable,
  DraftInput,
  fieldOf,
  DraftPersonChip,
  DraftRow,
  DraftText,
  useDraftWords,
} from "./draft";
import type { DraftPerson, DraftStatus } from "./draft";
import { DraftWhen } from "./when";

/** A guest: a person, with their busy time that day when the host knows it. */
export interface EventDraftPerson extends DraftPerson {
  busy?: readonly DraftBusy[];
}

/** The event as drafted. Times are ISO strings with their offset ("2026-11-19T14:00:00+01:00"). */
export interface EventDraftValue {
  title: string;
  start: string;
  end: string;
  people: readonly EventDraftPerson[];
  /** The video call: its words ("Google Meet") and the service's mark (a BrandIcon). */
  call?: { label: string; mark?: ReactNode };
  place?: string;
  description?: string;
}

/** Every prop an EventDraft takes. */
export interface EventDraftProps {
  /** Where the draft is (Draft's `status`): drafting, ready, sending, sent, failed or dismissed. */
  status?: DraftStatus;
  /** When it was made, ISO, for the sent line's time. */
  doneAt?: string;
  /** Undo on the sent line, for as long as the host can undo. */
  onUndo?: () => void;
  /** Restore on the dismissed line, for as long as the host can bring it back. */
  onRestore?: () => void;
  /** The event as it stands. */
  draft: EventDraftValue;
  /** Every change the person makes in place; left out, the draft is read only. */
  onDraftChange?: (draft: EventDraftValue) => void;
  /** Create event: the draft as it stands. Return a Promise and the button works until it settles. */
  onCreate: (draft: EventDraftValue) => unknown;
  /** Discard, at the foot's start. */
  onDismiss?: () => void;
  /** Open in the calendar, after Discard: the service's own page for the draft. */
  onOpen?: () => void;
  /** The calendar service's mark in the head (a BrandIcon); left out, the calendar icon. */
  mark?: ReactNode;
  /** The zone its times are shown in ("Europe/Amsterdam"); left out, the browser's. */
  timeZone?: string;
}

/** An event drafted in an answer, ready to change and create. */
export const EventDraft = ({
  draft,
  onDraftChange,
  onCreate,
  onDismiss,
  onOpen,
  mark,
  timeZone,
  status = "ready",
  doneAt,
  onUndo,
  onRestore,
}: EventDraftProps) => {
  const words = useDraftWords("event");
  // Fields change only while it can still be changed: ready, or failed and to be sent again.
  const field = fieldOf(draft, onDraftChange, status);
  const people = field("people");
  return (
    <Draft
      aria-label={`${words.kind}: ${draft.title}`}
      icon={CalendarIcon}
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
      main={{ label: words.create, onPress: () => onCreate(draft) }}
      onDismiss={onDismiss}
      status={status}
      done={
        doneAt === undefined
          ? words.created
          : `${words.created} · ${words.time(doneAt, timeZone)}`
      }
      onUndo={onUndo}
      onRestore={onRestore}
      secondary={
        onOpen === undefined ? undefined : (
          <Button variant="ghost" size="sm" onClick={onOpen}>
            {words.open}
          </Button>
        )
      }
    >
      <DraftDay
        title={draft.title}
        start={draft.start}
        end={draft.end}
        timeZone={timeZone}
        lanes={draft.people.map((person) => ({ person, busy: person.busy }))}
      />
      <DraftRow icon={Clock} label={words.when}>
        {onDraftChange !== undefined && draftEditable(status) ? (
          <DraftWhen
            start={draft.start}
            end={draft.end}
            words={words.span(draft.start, draft.end, timeZone)}
            onChange={(start, end) => {
              onDraftChange({ ...draft, start, end });
            }}
          />
        ) : (
          <span>{words.span(draft.start, draft.end, timeZone)}</span>
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
      {draft.call === undefined ? null : (
        <DraftRow icon={VideoCall} label={words.call}>
          {draft.call.mark}
          <span>{draft.call.label}</span>
        </DraftRow>
      )}
      <DraftRow icon={Place} label={words.place}>
        <DraftInput
          value={draft.place ?? ""}
          label={words.place}
          placeholder={words.addPlace}
          onValueChange={field("place")}
        />
      </DraftRow>
      <DraftRow icon={Note} label={words.description}>
        <DraftText
          value={draft.description ?? ""}
          label={words.description}
          placeholder={words.addDescription}
          onValueChange={field("description")}
        />
      </DraftRow>
    </Draft>
  );
};

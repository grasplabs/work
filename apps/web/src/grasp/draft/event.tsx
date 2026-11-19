// EventDraft: an event the agent drafted ("put a meeting with Jerry in my agenda tomorrow at two"),
// on the Draft frame. The day around it (everyone's busy time, the event across their lanes, and
// "Conflicts" where it meets someone's), then the when, the people, the call, the place and the
// description, then Create event. The title, the place and the description change in place; a
// person can be taken off. The host gets every change (`onDraftChange`) and the draft as it stands
// on Create (`onCreate`).
//
//   <EventDraft draft={event} onDraftChange={setEvent} onCreate={create} onDismiss={dismiss} timeZone="Europe/Amsterdam" />
//
// EventChangeDraft: a change to an event that exists (calendar.update), on the same frame: `was` is
// the event as it stands, `draft` as it will be. What changes leads, the old value quiet and struck
// under it ("Was" to a screen reader); a guest added says "New", a guest taken off stands struck;
// the day keeps the old slot as a dashed ghost on the same day. What does not change reads as an
// EventDraft. Save changes; "Event updated" once saved.
//
//   <EventChangeDraft was={event} draft={moved} onSave={save} onDismiss={dismiss} timeZone="Europe/Amsterdam" />
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Badge } from "../badge";
import { Button } from "../button";
import { visuallyHidden } from "../hidden/hidden";
import { CalendarIcon, Clock, Note, People, Place, VideoCall } from "../icons";
import type { IconData } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import { DraftDay } from "./day";
import type { DraftBusy } from "./day";
import {
  changeOf,
  Draft,
  draftEditable,
  draftKeys,
  DraftInput,
  withoutAt,
  fieldOf,
  filled,
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
  /** Every change the person makes in place; left out, the draft is locked, as `readOnly`. */
  onDraftChange?: (draft: EventDraftValue) => void;
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

/** Every prop an EventChangeDraft takes: an EventDraft's, with the event as it was and Save. */
export interface EventChangeDraftProps extends Omit<
  EventDraftProps,
  "onCreate"
> {
  /** The event as it stands in the calendar now; `draft` is the event as the change leaves it. */
  was: EventDraftValue;
  /** Save changes: the event as the change leaves it. Return a Promise and the button works until it settles. */
  onSave: (draft: EventDraftValue) => unknown;
}

/** What a kind on the event's frame changes: its name, its main action, its sent line, and what it was. */
interface EventKind {
  kind: string;
  mainLabel: string;
  doneWord: string;
  onMain: (draft: EventDraftValue) => unknown;
  was?: EventDraftValue;
}

type EventFrameProps = Omit<EventDraftProps, "onCreate"> & EventKind;

const styles = stylex.create({
  // The head's title, with what it was under it.
  title: { display: "grid", flexGrow: 1, minWidth: 0 },
  // A value as it was: quiet and struck, on its own line under the new one.
  was: {
    display: "block",
    flexBasis: "100%",
    minWidth: 0,
    margin: 0,
    color: grasp.muted,
    textDecorationLine: "line-through",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // A guest the change takes off: their chip struck and quiet.
  removed: {
    display: "inline-flex",
    maxWidth: "100%",
    textDecorationLine: "none",
  },
});

/** A value as it was, struck under the new one: "Was" said first. */
const Was = ({ children }: { children: ReactNode }) => {
  const words = useDraftWords("eventChange");
  return (
    <del data-slot="draft-was" {...stylex.props(styles.was)}>
      <span {...stylex.props(visuallyHidden)}>{`${words.was}: `}</span>
      {children}
    </del>
  );
};

/** A person's address, else their name: who they are, to tell who a change adds or takes off. */
const personKey = (person: DraftPerson) => person.email ?? person.name;

/** Whether an optional value differs between what it was and what it will be. */
const differs = (now: string | undefined, then: string | undefined) =>
  (now ?? "").trim() !== (then ?? "").trim();

/** Whether the time moves. */
const moves = (draft: EventDraftValue, was: EventDraftValue | undefined) =>
  was !== undefined &&
  (Date.parse(draft.start) !== Date.parse(was.start) ||
    Date.parse(draft.end) !== Date.parse(was.end));

/** The when row: the span, changed in place while the draft can change; what it was under it. */
const WhenRow = ({
  draft,
  was,
  change,
  status,
  timeZone,
}: {
  draft: EventDraftValue;
  was?: EventDraftValue;
  change?: (draft: EventDraftValue) => void;
  status: DraftStatus;
  timeZone?: string;
}) => {
  const words = useDraftWords("event");
  const span = words.span(draft.start, draft.end, timeZone);
  return (
    <DraftRow icon={Clock} label={words.when}>
      {change !== undefined && draftEditable(status) ? (
        <DraftWhen
          start={draft.start}
          end={draft.end}
          words={span}
          onChange={(start, end) => {
            change({ ...draft, start, end });
          }}
        />
      ) : (
        <span>{span}</span>
      )}
      {was !== undefined && moves(draft, was) ? (
        <Was>{words.span(was.start, was.end, timeZone)}</Was>
      ) : null}
    </DraftRow>
  );
};

/** The people row: the guests, each removable while the draft can lose them; with `was`, who is new and who is taken off. */
const PeopleRow = ({
  draft,
  was,
  remove,
  locked,
}: {
  draft: EventDraftValue;
  was?: EventDraftValue;
  remove?: (people: readonly EventDraftPerson[]) => void;
  locked: boolean;
}) => {
  const words = useDraftWords("event");
  const change = useDraftWords("eventChange");
  const before = new Set((was?.people ?? draft.people).map(personKey));
  const after = new Set(draft.people.map(personKey));
  const gone = (was?.people ?? []).filter(
    (person) => !after.has(personKey(person))
  );
  if (locked && draft.people.length === 0 && gone.length === 0) {
    return null;
  }
  const keys = draftKeys(draft.people);
  const goneKeys = draftKeys(gone);
  return (
    <DraftRow icon={People} label={words.people}>
      {draft.people.map((person, index) => (
        <span
          key={keys[index]}
          data-change={before.has(personKey(person)) ? undefined : "added"}
        >
          <DraftPersonChip
            whole={locked}
            person={person}
            badge={
              before.has(personKey(person)) ? undefined : (
                <Badge size="sm">{change.added}</Badge>
              )
            }
            onRemove={
              remove === undefined || person.you === true
                ? undefined
                : () => {
                    remove(withoutAt(draft.people, index));
                  }
            }
          />
        </span>
      ))}
      {gone.map((person, index) => (
        <del
          key={goneKeys[index]}
          data-change="removed"
          {...stylex.props(styles.removed)}
        >
          <span {...stylex.props(visuallyHidden)}>{`${change.removed}: `}</span>
          <DraftPersonChip struck whole={locked} person={person} />
        </del>
      ))}
    </DraftRow>
  );
};

/** A one-line field (a place) or one that grows (a description). */
const TextField = ({
  many,
  ...props
}: {
  many: boolean;
  readOnly: boolean;
  value: string;
  label: string;
  placeholder?: string;
  onValueChange?: (value: string) => void;
}) => (many ? <DraftText {...props} /> : <DraftInput {...props} />);

/** A text row (the place, the description): the value, in place or whole; what it was under it. */
const TextRow = ({
  icon,
  label,
  value,
  then,
  placeholder,
  onValueChange,
  locked,
  many = false,
}: {
  icon: IconData;
  label: string;
  value: string | undefined;
  then?: string;
  placeholder: string;
  onValueChange?: (value: string) => void;
  locked: boolean;
  many?: boolean;
}) => {
  const changed = then !== undefined && differs(value, then);
  if (locked && !filled(value) && !(changed && filled(then))) {
    return null;
  }
  const shown = {
    readOnly: locked,
    value: value ?? "",
    label,
    placeholder: locked ? undefined : placeholder,
    onValueChange,
  };
  return (
    <DraftRow icon={icon} label={label}>
      {locked && !filled(value) ? null : <TextField many={many} {...shown} />}
      {changed && filled(then) ? <Was>{then}</Was> : null}
    </DraftRow>
  );
};

/** The event's frame, shared by EventDraft and EventChangeDraft. */
const EventFrame = ({
  draft,
  was,
  onDraftChange,
  readOnly,
  mainHeld,
  onMain,
  onDismiss,
  onOpen,
  mark,
  timeZone,
  status = "ready",
  doneAt,
  onUndo,
  onRestore,
  kind,
  mainLabel,
  doneWord,
}: EventFrameProps) => {
  const words = useDraftWords("event");
  const change = changeOf(readOnly, onDraftChange);
  const locked = change === undefined;
  // Fields change only while it can still be changed: ready, or failed and to be sent again.
  const field = fieldOf(draft, change, status);
  const callChanged =
    was !== undefined && differs(draft.call?.label, was.call?.label);
  return (
    <Draft
      aria-label={`${kind}: ${draft.title}`}
      icon={CalendarIcon}
      mark={mark}
      title={
        <span {...stylex.props(styles.title)}>
          <DraftInput
            readOnly={locked}
            title
            value={draft.title}
            label={words.title}
            placeholder={locked ? undefined : words.title}
            onValueChange={field("title")}
          />
          {was !== undefined && differs(draft.title, was.title) ? (
            <Was>{was.title}</Was>
          ) : null}
        </span>
      }
      mainHeld={mainHeld}
      main={{ label: mainLabel, onPress: () => onMain(draft) }}
      onDismiss={onDismiss}
      status={status}
      done={
        doneAt === undefined
          ? doneWord
          : `${doneWord} · ${words.time(doneAt, timeZone)}`
      }
      onUndo={onUndo}
      onRestore={onRestore}
      readOnly={locked}
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
        was={moves(draft, was) ? was : undefined}
        timeZone={timeZone}
        lanes={draft.people.map((person) => ({ person, busy: person.busy }))}
      />
      <WhenRow
        draft={draft}
        was={was}
        change={change}
        status={status}
        timeZone={timeZone}
      />
      <PeopleRow
        draft={draft}
        was={was}
        remove={field("people")}
        locked={locked}
      />
      {draft.call === undefined && !callChanged ? null : (
        <DraftRow icon={VideoCall} label={words.call}>
          {draft.call?.mark}
          {draft.call === undefined ? null : <span>{draft.call.label}</span>}
          {callChanged && was.call !== undefined ? (
            <Was>{was.call.label}</Was>
          ) : null}
        </DraftRow>
      )}
      <TextRow
        icon={Place}
        label={words.place}
        value={draft.place}
        then={was?.place}
        placeholder={words.addPlace}
        onValueChange={field("place")}
        locked={locked}
      />
      <TextRow
        many
        icon={Note}
        label={words.description}
        value={draft.description}
        then={was?.description}
        placeholder={words.addDescription}
        onValueChange={field("description")}
        locked={locked}
      />
    </Draft>
  );
};

/** An event drafted in an answer, ready to change and create. */
export const EventDraft = ({ onCreate, ...props }: EventDraftProps) => {
  const words = useDraftWords("event");
  return (
    <EventFrame
      {...props}
      kind={words.kind}
      mainLabel={words.create}
      doneWord={words.created}
      onMain={onCreate}
    />
  );
};

/** A change to an event that exists, drafted in an answer: what changes against what it was. */
export const EventChangeDraft = ({
  onSave,
  ...props
}: EventChangeDraftProps) => {
  const words = useDraftWords("eventChange");
  return (
    <EventFrame
      {...props}
      kind={words.kind}
      mainLabel={words.save}
      doneWord={words.saved}
      onMain={onSave}
    />
  );
};

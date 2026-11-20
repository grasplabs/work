// EmailDraft: an email the agent drafted ("write Jerry an email about tomorrow"), on the Draft
// frame. To (and Cc, Bcc when asked for) as people's chips, the subject, the message and the
// signature under it, then Discard and the attach at the foot's start and Send at its end. The
// subject and the message change in place; a person can be taken off. The host gets every change
// (`onDraftChange`) and the email as it stands on Send (`onSend`).
//
//   <EmailDraft draft={email} onDraftChange={setEmail} onSend={send} onDismiss={discard} />
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../button";
import { Attach, Mail } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import {
  changeOf,
  Draft,
  draftEditable,
  draftKeys,
  DraftInput,
  fieldOf,
  withoutAt,
  DraftPersonChip,
  DraftText,
  useDraftWords,
} from "./draft";
import type { DraftPerson, DraftStatus } from "./draft";

/** The email as drafted. The message is plain text; a blank line parts its paragraphs. */
export interface EmailDraftValue {
  to: readonly DraftPerson[];
  cc?: readonly DraftPerson[];
  bcc?: readonly DraftPerson[];
  subject: string;
  body: string;
  /** Signed under the message, as the host keeps it; not changed here. */
  signature?: string;
}

/** Every prop an EmailDraft takes. */
export interface EmailDraftProps {
  /** Where the draft is (Draft's `status`): drafting, ready, sending, sent, failed or dismissed. */
  status?: DraftStatus;
  /** When it was made, ISO, for the sent line's time. */
  doneAt?: string;
  /** Undo on the sent line, for as long as the host can undo. */
  onUndo?: () => void;
  /** Restore on the dismissed line, for as long as the host can bring it back. */
  onRestore?: () => void;
  /** The email as it stands. */
  draft: EmailDraftValue;
  /** Every change the person makes in place; left out, the draft is locked, as `readOnly`. */
  onDraftChange?: (draft: EmailDraftValue) => void;
  /**
   * Locked: shown to be sent exactly as it is. No Cc / Bcc, no attach, no remove on a chip, no
   * empty Cc or Bcc row; its values stand as text, and the foot keeps Send and Discard. Leaving out
   * `onDraftChange` locks it the same way.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Holds the main action back until the host clears it, with the reason ("Read the whole email
   * first"), as ApprovalRequest's `approveHeld`: out of use but still reached by Tab, the reason
   * beside it and said with it. Discard stays usable.
   */
  mainHeld?: string;
  /** Send: the email as it stands. Return a Promise and the button works until it settles. */
  onSend: (draft: EmailDraftValue) => unknown;
  /** Discard, at the foot's start. */
  onDismiss?: () => void;
  /** Attach a file, after Discard; left out, no attach. */
  onAttach?: () => void;
  /** The mail service's mark in the head (a BrandIcon); left out, the mail icon. */
  mark?: ReactNode;
  /** The zone the sent line's time is shown in; left out, the browser's. */
  timeZone?: string;
}

const styles = stylex.create({
  // The kind's name in the head.
  kind: { fontWeight: grasp.weightMedium },
  // The addressee rows: a quiet name beside what it holds, the names in one column.
  fields: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    paddingBlockEnd: grasp.space3,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  // Locked, a value may take several lines: each name stands on its value's first line.
  fieldsLocked: { alignItems: "baseline" },
  name: { color: grasp.muted },
  // As tall as a small control in every state, so the draft keeps its height when Cc / Bcc goes.
  people: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    minHeight: grasp.controlSm,
  },
  // Cc / Bcc at the To row's end, quiet.
  more: { marginInlineStart: "auto" },
  signature: { margin: 0, color: grasp.muted, whiteSpace: "pre-line" },
});

/** A row of addressees: their chips, each removable while the draft can change. */
const People = ({
  people,
  change,
  whole,
}: {
  people: readonly DraftPerson[];
  change: ((people: readonly DraftPerson[]) => void) | undefined;
  whole: boolean;
}) => {
  const keys = draftKeys(people);
  return people.map((person, index) => (
    <DraftPersonChip
      whole={whole}
      key={keys[index]}
      person={person}
      onRemove={
        change === undefined
          ? undefined
          : () => {
              change(withoutAt(people, index));
            }
      }
    />
  ));
};

/** A Cc or Bcc row: its name and its people; locked, none while it has no one. */
const Copies = ({
  name,
  people,
  change,
  locked,
}: {
  name: string;
  people: readonly DraftPerson[];
  change: ((people: readonly DraftPerson[]) => void) | undefined;
  locked: boolean;
}) =>
  locked && people.length === 0 ? null : (
    <>
      <span {...stylex.props(styles.name)}>{name}</span>
      <div {...stylex.props(styles.people)}>
        <People people={people} change={change} whole={locked} />
      </div>
    </>
  );

/** What a kind on the email's frame changes: its name, its main action's words, and what stands under the message. */
interface EmailKind {
  kind: string;
  send: string;
  sent: string;
  /** Under the signature: a reply's original, folded. */
  after?: ReactNode;
}

/** The email's frame, shared by EmailDraft and ReplyDraft (reply.tsx). */
export const EmailFrame = ({
  draft,
  onDraftChange,
  readOnly,
  mainHeld,
  onSend,
  onDismiss,
  onAttach,
  mark,
  timeZone,
  status = "ready",
  doneAt,
  onUndo,
  onRestore,
  kind,
  send,
  sent,
  after,
}: EmailDraftProps & EmailKind) => {
  const words = useDraftWords("email");
  const change = changeOf(readOnly, onDraftChange);
  const locked = change === undefined;
  const cc = draft.cc ?? [];
  const bcc = draft.bcc ?? [];
  // Cc and Bcc show once asked for, or when the draft already has them; locked, only the one that has people.
  const [asked, setAsked] = useState(false);
  const copies = asked || cc.length + bcc.length > 0;
  // Fields change only while it can still be changed: ready, or failed and to be sent again.
  const field = fieldOf(draft, change, status);
  return (
    <Draft
      aria-label={`${kind}: ${draft.subject}`}
      icon={Mail}
      mark={mark}
      title={<span {...stylex.props(styles.kind)}>{kind}</span>}
      mainHeld={mainHeld}
      main={{ label: send, onPress: () => onSend(draft) }}
      onDismiss={onDismiss}
      status={status}
      done={
        doneAt === undefined
          ? sent
          : `${sent} · ${words.time(doneAt, timeZone)}`
      }
      onUndo={onUndo}
      onRestore={onRestore}
      readOnly={locked}
      secondary={
        onAttach === undefined ||
        locked ||
        !draftEditable(status) ? undefined : (
          <Button
            variant="ghost"
            size="sm"
            icon={Attach}
            aria-label={words.attach}
            onClick={onAttach}
          />
        )
      }
    >
      <div {...stylex.props(styles.fields, locked && styles.fieldsLocked)}>
        <span {...stylex.props(styles.name)}>{words.to}</span>
        <div {...stylex.props(styles.people)}>
          <People people={draft.to} change={field("to")} whole={locked} />
          {copies || locked || !draftEditable(status) ? null : (
            <span {...stylex.props(styles.more)}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAsked(true);
                }}
              >
                {words.addCc}
              </Button>
            </span>
          )}
        </div>
        {copies ? (
          <>
            <Copies
              name={words.cc}
              people={cc}
              change={field("cc")}
              locked={locked}
            />
            <Copies
              name={words.bcc}
              people={bcc}
              change={field("bcc")}
              locked={locked}
            />
          </>
        ) : null}
        <span {...stylex.props(styles.name)}>{words.subject}</span>
        <DraftInput
          readOnly={locked}
          value={draft.subject}
          label={words.subject}
          onValueChange={field("subject")}
        />
      </div>
      <DraftText
        readOnly={locked}
        value={draft.body}
        label={words.body}
        placeholder={locked ? undefined : words.body}
        onValueChange={field("body")}
      />
      {draft.signature === undefined ? null : (
        <p data-slot="draft-signature" {...stylex.props(styles.signature)}>
          {draft.signature}
        </p>
      )}
      {after}
    </Draft>
  );
};

/** An email drafted in an answer, ready to change and send. */
export const EmailDraft = (props: EmailDraftProps) => {
  const words = useDraftWords("email");
  return (
    <EmailFrame
      {...props}
      kind={words.kind}
      send={words.send}
      sent={words.sent}
    />
  );
};

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
  Draft,
  draftEditable,
  DraftInput,
  fieldOf,
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
  /** Every change the person makes in place; left out, the draft is read only. */
  onDraftChange?: (draft: EmailDraftValue) => void;
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
}: {
  people: readonly DraftPerson[];
  change: ((people: readonly DraftPerson[]) => void) | undefined;
}) =>
  people.map((person) => (
    <DraftPersonChip
      key={person.email ?? person.name}
      person={person}
      onRemove={
        change === undefined
          ? undefined
          : () => {
              change(people.filter((other) => other !== person));
            }
      }
    />
  ));

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
  // Cc and Bcc show once asked for, or when the draft already has them.
  const [copies, setCopies] = useState(
    (draft.cc?.length ?? 0) + (draft.bcc?.length ?? 0) > 0
  );
  // Fields change only while it can still be changed: ready, or failed and to be sent again.
  const field = fieldOf(draft, onDraftChange, status);
  return (
    <Draft
      aria-label={`${kind}: ${draft.subject}`}
      icon={Mail}
      mark={mark}
      title={<span {...stylex.props(styles.kind)}>{kind}</span>}
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
      secondary={
        onAttach === undefined || !draftEditable(status) ? undefined : (
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
      <div {...stylex.props(styles.fields)}>
        <span {...stylex.props(styles.name)}>{words.to}</span>
        <div {...stylex.props(styles.people)}>
          <People people={draft.to} change={field("to")} />
          {copies || !draftEditable(status) ? null : (
            <span {...stylex.props(styles.more)}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCopies(true);
                }}
              >
                {words.addCc}
              </Button>
            </span>
          )}
        </div>
        {copies ? (
          <>
            <span {...stylex.props(styles.name)}>{words.cc}</span>
            <div {...stylex.props(styles.people)}>
              <People people={draft.cc ?? []} change={field("cc")} />
            </div>
            <span {...stylex.props(styles.name)}>{words.bcc}</span>
            <div {...stylex.props(styles.people)}>
              <People people={draft.bcc ?? []} change={field("bcc")} />
            </div>
          </>
        ) : null}
        <span {...stylex.props(styles.name)}>{words.subject}</span>
        <DraftInput
          value={draft.subject}
          label={words.subject}
          onValueChange={field("subject")}
        />
      </div>
      <DraftText
        value={draft.body}
        label={words.body}
        placeholder={words.body}
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

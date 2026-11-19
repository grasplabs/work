// MessageDraft: a message the agent drafted for a channel or a person ("tell #finance the Kestrel
// terms changed"), on the Draft frame: where it goes as a chip with the service's mark (a BrandIcon
// the host gives), then the message, editable, then Discard and Send message. The host gets every
// change (`onDraftChange`) and the message as it stands on Send (`onSend`).
//
//   <MessageDraft draft={{ to: { name: "#finance", mark: <BrandIcon brand="slack" size="xs" tile={false} /> }, text }} onSend={send} />
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Conversation } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import { changeOf, Draft, DraftText, fieldOf, useDraftWords } from "./draft";
import type { DraftStatus } from "./draft";

/** Where a message goes: a channel or a person, by the name the service shows, with its mark. */
export interface MessageDraftPlace {
  /** Its name as the service shows it ("#finance", "Jerry van der Horst"). */
  name: string;
  /** The service's mark (a BrandIcon at `xs` with `tile={false}`: no tile inside the pill), or the person's face. */
  mark?: ReactNode;
}

/** The message as drafted: where it goes and its words (plain text; a blank line parts paragraphs). */
export interface MessageDraftValue {
  to: MessageDraftPlace;
  text: string;
}

/** Every prop a MessageDraft takes. */
export interface MessageDraftProps {
  /** Where the draft is (Draft's `status`): drafting, ready, sending, sent, failed or dismissed. */
  status?: DraftStatus;
  /** When it was sent, ISO, for the sent line's time. */
  doneAt?: string;
  /** Undo on the sent line, for as long as the host can undo. */
  onUndo?: () => void;
  /** Restore on the dismissed line, for as long as the host can bring it back. */
  onRestore?: () => void;
  /** The message as it stands. */
  draft: MessageDraftValue;
  /** Every change the person makes in place; left out, the draft is locked, as `readOnly`. */
  onDraftChange?: (draft: MessageDraftValue) => void;
  /**
   * Locked: shown to be made exactly as it is. No way to change it, no remove on a chip, no
   * placeholder and no empty optional row; its values stand as text, and the foot keeps its main
   * action and Discard. Leaving out `onDraftChange` locks it the same way.
   * @default false
   */
  readOnly?: boolean;
  /** Send message: the message as it stands. Return a Promise and the button works until it settles. */
  onSend: (draft: MessageDraftValue) => unknown;
  /** Discard, at the foot's start. */
  onDismiss?: () => void;
  /** The service's mark in the head (a BrandIcon); left out, the message icon. */
  mark?: ReactNode;
  /** The zone the sent line's time is shown in; left out, the browser's. */
  timeZone?: string;
}

const styles = stylex.create({
  kind: { fontWeight: grasp.weightMedium },
  // Where it goes: a quiet name beside a chip, then a hairline before the words, as an email's head.
  to: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
    minHeight: grasp.controlSm,
    paddingBlockEnd: grasp.space3,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  name: { color: grasp.muted },
  // The place: a pill with the service's mark and the name, as a person's chip.
  place: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    height: grasp.controlXs,
    boxSizing: "border-box",
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerPill,
    cornerShape: "round",
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.ink,
  },
  placeMark: { display: "inline-flex", flexShrink: 0 },
  placeName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // Locked: a long name wraps inside the chip, never cut (as a person's chip does).
  placeWhole: {
    alignItems: "flex-start",
    height: "auto",
    minHeight: grasp.controlXs,
    paddingBlock: `calc((${grasp.controlXs} - ${grasp.textXsLine}) / 2)`,
    borderRadius: `calc(${grasp.controlXs} / 2)`,
  },
  placeMarkWhole: { alignItems: "center", height: grasp.textXsLine },
  placeNameWhole: {
    overflow: "visible",
    textOverflow: "clip",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
});

/** A message drafted in an answer, ready to change and send. */
export const MessageDraft = ({
  draft,
  onDraftChange,
  readOnly,
  onSend,
  onDismiss,
  mark,
  timeZone,
  status = "ready",
  doneAt,
  onUndo,
  onRestore,
}: MessageDraftProps) => {
  const words = useDraftWords("message");
  const change = changeOf(readOnly, onDraftChange);
  const locked = change === undefined;
  const field = fieldOf(draft, change, status);
  return (
    <Draft
      aria-label={`${words.kind}: ${draft.to.name}`}
      icon={Conversation}
      mark={mark}
      title={<span {...stylex.props(styles.kind)}>{words.kind}</span>}
      main={{ label: words.send, onPress: () => onSend(draft) }}
      onDismiss={onDismiss}
      status={status}
      done={
        doneAt === undefined
          ? words.sent
          : `${words.sent} · ${words.time(doneAt, timeZone)}`
      }
      onUndo={onUndo}
      onRestore={onRestore}
      readOnly={locked}
    >
      <div {...stylex.props(styles.to)}>
        <span {...stylex.props(styles.name)}>{words.to}</span>
        <span
          data-slot="draft-place"
          {...stylex.props(styles.place, locked && styles.placeWhole)}
        >
          {draft.to.mark === undefined ? null : (
            <span
              aria-hidden="true"
              {...stylex.props(
                styles.placeMark,
                locked && styles.placeMarkWhole
              )}
            >
              {draft.to.mark}
            </span>
          )}
          <span
            {...stylex.props(styles.placeName, locked && styles.placeNameWhole)}
          >
            {draft.to.name}
          </span>
        </span>
      </div>
      <DraftText
        readOnly={locked}
        value={draft.text}
        label={words.text}
        placeholder={locked ? undefined : words.text}
        onValueChange={field("text")}
      />
    </Draft>
  );
};

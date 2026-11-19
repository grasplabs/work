// ReplyDraft: a reply the agent drafted inside an existing thread ("answer Lena and say yes to
// Friday"), on the email's own frame (EmailFrame): To, the subject, the reply and the signature, then
// the message it answers, folded under "Lena wrote on Tue 17 Nov, 09:12" (a Collapsible), quoted in
// muted words. Send reply; Discard and attach at the foot's start.
//
//   <ReplyDraft draft={reply} onDraftChange={setReply} onSend={send} onDismiss={discard} />
"use client";

import * as stylex from "@stylexjs/stylex";

import { Collapsible } from "../collapsible";
import { grasp } from "../tokens/tokens.stylex";
import type { DraftPerson } from "./draft";
import { useDraftWords } from "./draft";
import { EmailFrame } from "./email";
import type { EmailDraftProps, EmailDraftValue } from "./email";

/** The message a reply answers: who wrote it, when (ISO), and its words. */
export interface ReplyDraftOriginal {
  from: DraftPerson;
  at: string;
  text: string;
}

/** The reply as drafted: an email, and the message it answers. */
export interface ReplyDraftValue extends EmailDraftValue {
  original: ReplyDraftOriginal;
}

/** Every prop a ReplyDraft takes: the email's, with the reply's draft. */
export interface ReplyDraftProps extends Omit<
  EmailDraftProps,
  "draft" | "onDraftChange" | "onSend"
> {
  /** The reply as it stands, with the message it answers. */
  draft: ReplyDraftValue;
  /** Every change the person makes in place; left out, the draft is read only. */
  onDraftChange?: (draft: ReplyDraftValue) => void;
  /** Send reply: the reply as it stands. */
  onSend: (draft: ReplyDraftValue) => unknown;
}

const styles = stylex.create({
  // The original, quoted: muted words beside a hairline, as a quote in an answer.
  quote: {
    margin: 0,
    paddingInlineStart: grasp.space3,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
    color: grasp.muted,
    whiteSpace: "pre-line",
  },
});

/** A reply drafted in an answer, the message it answers folded under it. */
export const ReplyDraft = ({
  draft,
  onDraftChange,
  onSend,
  timeZone,
  ...rest
}: ReplyDraftProps) => {
  const words = useDraftWords("reply");
  const { original } = draft;
  return (
    <EmailFrame
      {...rest}
      timeZone={timeZone}
      draft={draft}
      onDraftChange={
        onDraftChange === undefined
          ? undefined
          : (next) => {
              onDraftChange({ ...next, original });
            }
      }
      onSend={() => onSend(draft)}
      kind={words.kind}
      send={words.send}
      sent={words.sent}
      after={
        <Collapsible
          title={words.wrote(original.from.name, original.at, timeZone)}
        >
          <p data-slot="draft-original" {...stylex.props(styles.quote)}>
            {original.text}
          </p>
        </Collapsible>
      }
    />
  );
};

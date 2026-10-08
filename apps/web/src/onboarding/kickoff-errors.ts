import { kickoffErrors } from "@grasp-os/shared/kickoff";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Why the kickoff was refused, in the area's language: core says it in
// English (`kickoffErrors`), and staff bring transcripts in in theirs.

const messages: Record<
  NonNullable<ReturnType<typeof kickoffErrors.codeOf>>,
  MessageDescriptor
> = {
  "kickoff.too_short": msg`That is too short to be a conversation.`,
  "kickoff.too_long": msg`That transcript is too long. Bring in the conversation itself, without attachments.`,
  "kickoff.unreadable": msg`That file couldn't be read. Bring in a .txt, .vtt, .srt or .docx transcript, or paste it.`,
  "kickoff.not_read": msg`The conversation couldn't be read just now. Try again in a moment.`,
  "kickoff.invalid": msg`That isn't something the kickoff takes.`,
};

/** `error` with its message in the area's language, when it is the kickoff's own. */
export const inLanguage = (i18n: I18n, error: unknown): unknown => {
  const code = kickoffErrors.codeOf(error);
  return code === undefined ? error : new Error(i18n._(messages[code]));
};

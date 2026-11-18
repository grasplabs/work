// Approval request's own words, in English. The product gives them in its languages through
// GraspWords (src/words); a caller's `words`, `approveLabel`, `changesPlaceholder` and `viewer` still
// win until the breaking release's step 5. A word built from others is a function.
import type { ApprovalWords } from "./approval-request";

const englishWords: ApprovalWords = {
  theAgent: "The agent",
  details: "Details",
  askForChanges: "Ask for changes",
  whatShouldChange: "What should change",
  back: "Back",
  send: "Send to the agent",
  decline: "Decline",
  final: "cannot be undone",
  sure: "Approve it?",
  sureFinal: "Approve it? This cannot be undone.",
  notYet: "Not yet",
  yes: "Yes",
  confirm: (yes, approve) =>
    `${yes}, ${approve.charAt(0).toLowerCase()}${approve.slice(1)}`,
  signed: (decided, by) => `${decided} by ${by}`,
  you: "you",
  undo: "Undo",
  approving: "Approving",
  declining: "Declining",
  sending: "Sending",
  couldNotApprove: "Failed",
  couldNotDecline: "Failed",
  couldNotSend: "Could not send",
  approved: "Approved",
  declined: "Declined",
  changes: "Changes asked",
  expired: "Expired",
  superseded: "Replaced by a newer request",
  undone: "Undone, waiting again",
};

export const approvalRequestWords = {
  ...englishWords,
  /** The words on Approve, when the host gives none that say what it does (`approveLabel`). */
  approve: "Approve",
  /** The field's placeholder when asking for changes (`changesPlaceholder`). */
  changesPlaceholder: "Say what should change",
  /** Who is looking, by name, when the host gives none (`viewer`): "Approved by You". */
  viewer: "You",
};

export type ApprovalRequestWords = typeof approvalRequestWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    approvalRequest: ApprovalRequestWords;
  }
}

import { useLingui } from "@lingui/react/macro";

import type { ApprovalWords } from "../grasp/approval-request/index.ts";

// What Grasp UI's Approval request says, in the page's language: the card
// the chat's agent asks on (chat/connection-requests.tsx,
// chat/package-requests.tsx). Its words are props, not the parts' shared
// words (frame/part-words.tsx), so they are given here, once.

/** Every word the Approval request shows, in the page's language. */
export const useApprovalWords = (): ApprovalWords => {
  const { t } = useLingui();
  return {
    theAgent: t`The agent`,
    details: t`Details`,
    askForChanges: t`Ask for changes`,
    whatShouldChange: t`What should change`,
    back: t`Back`,
    send: t`Send to the agent`,
    decline: t({ message: "Decline", context: "an agent's request" }),
    final: t`cannot be undone`,
    sure: t`Approve it?`,
    sureFinal: t`Approve it? This cannot be undone.`,
    notYet: t`Not yet`,
    yes: t({ message: "Yes", context: "before the approve words" }),
    // The approve words as they stand: a language may not start them
    // lower case (German nouns).
    confirm: (yes, approve) => t`${yes}: ${approve}`,
    signed: (decided, by) => t`${decided} by ${by}`,
    you: t({ message: "you", context: "who answered an agent's request" }),
    undo: t`Undo`,
    approving: t`Approving`,
    declining: t`Declining`,
    sending: t`Sending`,
    couldNotApprove: t`Could not approve`,
    couldNotDecline: t`Could not decline`,
    couldNotSend: t`Could not send`,
    approved: t({ message: "Approved", context: "an agent's request" }),
    declined: t({ message: "Declined", context: "an agent's request" }),
    changes: t`Changes asked`,
    expired: t({ message: "Expired", context: "an agent's request" }),
    superseded: t`Replaced by a newer request`,
    undone: t`Undone, waiting again`,
  };
};

// Chat message's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const chatMessageWords = {
  /** Who a person's message is from, said to a screen reader (`personLabel`). */
  person: "You",
  /** In place of an agent's message that could not be written (`failedLabel`). */
  failed: "Could not answer",
  /** The button that tries again after a failure (`retryLabel`). */
  retry: "Try again",
  /** The name of the row of actions under a message (`actionsLabel`). */
  actions: "Message actions",
  /** Copy's name (`copyLabels.copy`). */
  copy: "Copy",
  /** Said once a copy worked (`copyLabels.copied`). */
  copied: "Copied",
  /** Said when a copy failed (`copyLabels.failed`). */
  copyFailed: "Could not copy",
  /** Said to a screen reader while the agent writes (`streamingLabel`). */
  streaming: "Writing",
  /** Said to a screen reader once the agent has finished writing (`doneLabel`). */
  done: "Answer ready",
  /** The thinking line while the agent works (`thinkingLabel`). */
  thinking: "Thinking",
  /** What the thinking line settles to, from how many seconds it took (`thoughtLabel`). */
  thought: (seconds: number) =>
    `Thought for ${seconds} ${seconds === 1 ? "second" : "seconds"}`,
};

export type ChatMessageWords = typeof chatMessageWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    chatMessage: ChatMessageWords;
  }
}

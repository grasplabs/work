import type { ChatMessage } from "@grasp-os/shared/chat";

// Whether Grasp's turn after a Build it ended (frame/setting-up.tsx): read
// from the chat itself, so a turn over before the page came, or a reload,
// lands where a turn seen ending would.

/** What a Build it made: an App or a workflow, by ID. */
export interface Made {
  kind: "app" | "workflow";
  id: string;
}

/**
 * Whether the agent answered after the last Build it in `messages` that
 * made `made`: false while none made it, or none answered yet.
 */
export const answeredAfterBuild = (
  messages: readonly ChatMessage[],
  made: Made
): boolean => {
  const built = messages.findLastIndex(
    (message) =>
      message.role === "user" && message.built?.[made.kind]?.id === made.id
  );
  return (
    built !== -1 &&
    messages.slice(built + 1).some(({ role }) => role === "assistant")
  );
};

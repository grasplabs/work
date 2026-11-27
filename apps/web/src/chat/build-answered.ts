import type { ChatMade, ChatMessage } from "@grasp-os/shared/chat";

// Whether Grasp's turn after a Build it ended (frame/setting-up.tsx): read
// from the chat itself, so a turn over before the page came, or a reload,
// lands where a turn seen ending would. Core says what was answered as the
// tab began to follow the chat (`ChatUpdate.answeredBuilds`), however far
// back that Build it lies; what came since, the messages say.

/**
 * Whether the agent answered after the last Build it that made `made`:
 * among the messages since the tab began to follow the chat, else as core
 * said then (`answeredBuilds`). False while none made it, or none
 * answered yet.
 */
export const answeredAfterBuild = (
  {
    messages,
    answeredBuilds,
  }: { messages: readonly ChatMessage[]; answeredBuilds: readonly ChatMade[] },
  made: ChatMade
): boolean => {
  const built = messages.findLastIndex(
    (message) =>
      message.role === "user" && message.built?.[made.kind]?.id === made.id
  );
  if (built === -1) {
    return answeredBuilds.some(
      ({ kind, id }) => kind === made.kind && id === made.id
    );
  }
  return messages.slice(built + 1).some(({ role }) => role === "assistant");
};

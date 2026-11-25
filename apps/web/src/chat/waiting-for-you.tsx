import { useAnswersPause } from "../answer-pause.tsx";
import { ConnectionRequests } from "./connection-requests.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { PackageRequests } from "./package-requests.tsx";

// What waits on the person under the chat's last answer: the writes held
// for them, then the connections and the packages the agent asked for,
// each a card with its answers, one under the other. An answer takes its
// card away, or says above the writes why it failed, and every card
// under it, in any of the three, moves up into its place: so after each,
// every answer here holds for a moment (answer-pause.tsx), as the Inbox's
// next item does. The second press of a double click, meant for the card
// answered, never confirms a write, grants a connection or approves
// packages the person never read.

export const WaitingForYou = ({
  chatId,
  version,
  onConfirmed,
  onApproved,
}: {
  chatId: string;
  /** Changes when core says something waits, or no longer does (`ChatUpdate.held`). */
  version: number;
  /** Told each time a held write's confirmation went through. */
  onConfirmed: () => void;
  /** Told once packages are approved. */
  onApproved: () => void;
}) => {
  const pause = useAnswersPause();
  return (
    <>
      <HeldWrites
        chatId={chatId}
        onConfirmed={onConfirmed}
        pause={pause}
        version={version}
      />
      <ConnectionRequests chatId={chatId} pause={pause} version={version} />
      <PackageRequests
        chatId={chatId}
        onApproved={onApproved}
        pause={pause}
        version={version}
      />
    </>
  );
};

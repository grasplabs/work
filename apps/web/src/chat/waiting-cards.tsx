import { ConnectionRequests } from "./connection-requests.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { PackageRequests } from "./package-requests.tsx";

// What a chat's agent left waiting for the person, under the thread: the
// writes it had held for them to confirm, the connections it asked for,
// and the npm packages it asked for. The one place every chat (Chat's own
// page, its dock and an App's chat) shows them, so none of them misses a
// kind. Each is read again when `version` changes (`ChatUpdate.held`).

/** The cards of what chat `chatId` waits on the person for. */
export const WaitingCards = ({
  chatId,
  version,
}: {
  chatId: string;
  version: number;
}) => (
  <>
    <HeldWrites chatId={chatId} version={version} />
    <ConnectionRequests chatId={chatId} version={version} />
    <PackageRequests chatId={chatId} version={version} />
  </>
);

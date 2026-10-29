import type { ChatSummary } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Trans } from "@lingui/react/macro";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { activeChat, setActiveChat } from "./active-chat.ts";

// Deleting a chat, from its row in the list of chats or from the menu in
// the open chat's header: the same question first, either way.

/** Deletes a chat, once the person confirms. */
export const DeleteChatDialog = ({
  chat,
  active,
  open,
  onOpenChange,
}: {
  chat: ChatSummary;
  /** Whether it is the open chat: then the page leaves it for a new one. */
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { title } = chat;
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.chats.remove(chat.id);
      return true;
    });
    if (removed === true) {
      onOpenChange(false);
      // A deleted chat is nobody's open chat any more.
      if (activeChat() === chat.id) {
        setActiveChat(undefined);
      }
      if (active) {
        await navigate({ to: "/", search: {} });
      }
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Delete “{title}”?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>
            Its messages are deleted for good, and every change its agent holds
            for you is rejected. What the agent did stays in the audit log.
          </Trans>
        </p>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy}
            onClick={() => {
              void remove();
            }}
            variant="destructive"
          >
            <Trans>Delete</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

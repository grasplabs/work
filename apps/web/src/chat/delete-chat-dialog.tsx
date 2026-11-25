import type { ChatSummary } from "@grasp-os/shared/chat";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { useCoreAction } from "../use-core-action.ts";
import { forgetChat } from "./active-chat.ts";
import { FailureLine } from "./failure-line.tsx";

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
      // A deleted chat is nobody's open chat any more, an App's included.
      forgetChat(chat.id);
      if (active) {
        await navigate({ to: "/", search: {} });
      }
      await router.invalidate();
    }
  };
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Delete “{title}”?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              Its messages are deleted for good, and every change its agent
              holds for you is rejected. What the agent did stays in the audit
              log.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FailureLine>{failure}</FailureLine>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          {/* Not a closing answer: the dialog stays to say why it failed. */}
          <Button disabled={busy} onClick={remove} variant="destructive">
            <Trans>Delete</Trans>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

import type { ChatSummary } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { ErrorText } from "../error-text.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { forgetChat } from "./active-chat.ts";

// Deleting a chat, from its row in the list of chats or from the menu in
// the open chat's header: the same question first, either way, in Grasp
// UI's alert dialog. Delete works on its own button, which says it if core
// refused; core's reason stands under the question.

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
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const { title } = chat;
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.chats.remove(chat.id);
      return true;
    });
    if (removed !== true) {
      // The dialog stays, its Delete saying it failed.
      throw new Error("The chat was not deleted");
    }
    // A deleted chat is nobody's open chat any more, an App's included.
    forgetChat(chat.id);
    if (active) {
      await navigate({ to: "/", search: {} });
    }
    await router.invalidate();
  };
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Delete “${title}”?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Its messages are deleted for good, and every change its agent holds for you is rejected. What the agent did stays in the audit log.`}
        </AlertDialogDescription>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            action={remove}
            failedLabel={t`Not deleted`}
            variant="danger"
          >
            {t`Delete`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

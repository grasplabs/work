import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { PromptInputButton } from "@grasp-os/ui/components/prompt-input";
import { Trans, useLingui } from "@lingui/react/macro";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { ChatList, useSelectChat } from "./chat-window.tsx";

/**
 * The person's recent chats, behind `trigger` (what it says, `children`):
 * the box's Recents on Chat's own page, and the open chat's title at the
 * head of the chat. One opens in Grasp's chat, where this page allows it.
 */
export const Recents = ({
  trigger,
  align = "end",
  children,
}: {
  trigger: ReactElement;
  /** Which of the trigger's edges the list lines up with. */
  align?: "start" | "end";
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const selectChat = useSelectChat();
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        aria-label={t`Recent chats`}
        className="w-80"
        variant="flush"
      >
        <ChatList
          onOpen={(chatId) => {
            setOpen(false);
            selectChat(chatId);
          }}
          shown={open}
        />
      </PopoverContent>
    </Popover>
  );
};

/** The box's Recents: the person's recent chats, from where they ask. */
export const RecentsButton = () => (
  <Recents trigger={<PromptInputButton />}>
    <HistoryIcon />
    <Trans>Recents</Trans>
  </Recents>
);

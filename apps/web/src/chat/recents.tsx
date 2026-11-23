import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { PromptInputButton } from "@grasp-os/ui/components/prompt-input";
import { ClockIcon, Icon } from "@grasp-os/ui/lib/icons";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ChatList, useSelectChat } from "./chat-window.tsx";

/**
 * The person's recent chats, from where they ask: the box's Recents. One
 * opens in Grasp's chat, where this page allows it.
 */
export const RecentsButton = () => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const selectChat = useSelectChat();
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <PromptInputButton>
          <Icon icon={ClockIcon} />
          <Trans>Recents</Trans>
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={t`Recent chats`} side="top">
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

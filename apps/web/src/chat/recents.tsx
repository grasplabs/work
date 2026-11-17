import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { Clock } from "../grasp/icons/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { ChatList, useSelectChat } from "./chat-window.tsx";

/**
 * The box's Recents: the person's recent chats, from where they ask, on
 * Chat's own page and in the open chat. One opens on its own page.
 */
export const RecentsButton = () => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const selectChat = useSelectChat();
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger icon={Clock} size="sm" variant="ghost">
        {t`Recents`}
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={t`Recent chats`}>
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

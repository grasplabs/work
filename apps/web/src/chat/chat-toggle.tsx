import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Icon, PanelRightIcon } from "@grasp-os/ui/lib/icons";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";

import { shortcutLabel } from "../shortcuts.ts";
import { closeChat, useChatLayout } from "./chat-layout.ts";
import { useChatPresence, useOpenChat } from "./chat-presence.ts";
import { chatKey } from "./global-chat.tsx";

/**
 * Shows or hides Grasp's chat beside the page, at the card's end at the
 * page bar's height (frame/app-frame.tsx lays it there, and the bar keeps
 * room for it: frame/site-header.tsx), as #2503's shell has it: on every
 * page the chat may float over, so its history opens without asking.
 */
export const ChatToggle = ({ style }: { style?: LayoutStyle }) => {
  const { t } = useLingui();
  const presence = useChatPresence();
  const { open } = useChatLayout();
  const openHere = useOpenChat();
  if (!presence.placements.includes("floating")) {
    return null;
  }
  const label = t`Show or hide the chat`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={label}
          data-slot="chat-toggle"
          onClick={() => {
            if (open) {
              closeChat();
            } else {
              openHere();
            }
          }}
          size="icon-xs"
          style={style}
          variant="ghost"
        >
          <Icon icon={PanelRightIcon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{`${label} (${shortcutLabel(chatKey)})`}</TooltipContent>
    </Tooltip>
  );
};

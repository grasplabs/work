import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Icon, PanelRightIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { shortcutLabel } from "../shortcuts.ts";
import { closeChat } from "./chat-layout.ts";
import { useOpenChat } from "./chat-presence.ts";
import { chatKey, useShellChat } from "./global-chat.tsx";

/**
 * Shows or hides Grasp's chat beside the page, at the end of the page's
 * bar (frame/site-header.tsx), as #2503's shell has it: on every page whose
 * foot has the chat's bar, so its history opens without asking. Not where
 * the chat stays open about the page's subject, nor outside the shell.
 */
export const ChatToggle = () => {
  const { t } = useLingui();
  const chat = useShellChat();
  const openHere = useOpenChat();
  if (chat === null || !chat.available || !chat.presence.bar) {
    return null;
  }
  const label = t`Show or hide the chat`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-expanded={chat.open}
          aria-label={label}
          onClick={() => {
            if (chat.open) {
              closeChat();
            } else {
              openHere();
            }
          }}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={PanelRightIcon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{`${label} (${shortcutLabel(chatKey)})`}</TooltipContent>
    </Tooltip>
  );
};

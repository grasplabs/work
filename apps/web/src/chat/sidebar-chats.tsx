import type { ChatSummary } from "@grasp-os/shared/chat";
import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import {
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  SidebarCollapsible,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import { ChevronDownIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { useCore } from "../use-core.ts";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import { useOpenChat } from "./chat-presence.ts";
import { useChatsWindow } from "./chat-switcher.tsx";

// The person's recent chats in the sidebar, as the reference's: a group of
// their own under the sections, named "Chats" with how many it lists,
// folded as the person left it; the most recently used first, a few of
// them, each opening in Grasp's chat beside the page, its agent's Working
// mark at its end while it answers; then All chats, the chats window (as
// the search, ⌘K). Read from core when the sidebar first shows and again
// after each page the router resolves (a rename or a delete reads the
// page again).

/** How many recent chats the sidebar lists. */
const recentCount = 8;

/** The person's chats from core, the most recently used first. */
const useChats = (): ChatSummary[] => {
  const core = useCore();
  const router = useRouter();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // Only the latest read's answer shows: an earlier one may come back after it.
  const latest = useRef(0);
  const read = useEffectEvent(() => {
    latest.current += 1;
    const asked = latest.current;
    void (async () => {
      try {
        const listed = await core.withSession(
          async (session) => await session.chats.list()
        );
        if (asked === latest.current) {
          setChats(listed);
        }
      } catch {
        // The sidebar keeps what it last read; the chats window says why.
      }
    })();
  });
  useEffect(() => {
    read();
    return router.subscribe("onResolved", () => {
      read();
    });
  }, [router]);
  return chats;
};

const styles = stylex.create({
  // The count, then the fold's mark, at the label's end.
  end: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    marginInlineStart: "auto",
  },
});

/** The sidebar's recent chats and All chats; nothing when the person has none. */
export const RecentChats = () => {
  const { t } = useLingui();
  const chats = useChats().slice(0, recentCount);
  const activeId = useActiveChat();
  const openHere = useOpenChat();
  const openChats = useChatsWindow();
  const { setOpenMobile } = useSidebar();
  const labelId = useId();
  if (chats.length === 0) {
    return null;
  }
  return (
    <SidebarCollapsible name="chats">
      <SidebarGroup>
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel asChild>
            <button id={labelId} type="button">
              <Trans>Chats</Trans>
              <span {...stylex.props(styles.end)}>
                {chats.length}
                <span aria-hidden="true">
                  <Icon icon={ChevronDownIcon} />
                </span>
              </span>
            </button>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu aria-labelledby={labelId}>
            {chats.map((chat) => (
              <SidebarMenuItem key={chat.id}>
                <SidebarMenuButton
                  isActive={chat.id === activeId}
                  onClick={() => {
                    // The chat opens beside the page: the phone's sheet goes first.
                    setOpenMobile(false);
                    setActiveChat(chat.id);
                    openHere();
                  }}
                >
                  {chat.title}
                </SidebarMenuButton>
                {chat.running ? (
                  <SidebarMenuBadge>
                    <AgentIndicator aria-label={t`Answering`} />
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            ))}
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  // The window opens over the page: the phone's sheet goes first.
                  setOpenMobile(false);
                  openChats(true);
                }}
              >
                <Trans>All chats</Trans>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarGroup>
    </SidebarCollapsible>
  );
};

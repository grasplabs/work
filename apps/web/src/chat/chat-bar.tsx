import type { DockablePlacement } from "@grasp-os/ui/components/dockable-panel";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { Kbd } from "@grasp-os/ui/components/kbd";
import {
  PromptBar,
  PromptBarAction,
  PromptBarActions,
  PromptBarIcon,
} from "@grasp-os/ui/components/prompt-bar";
import type { PromptEditorHandle } from "@grasp-os/ui/components/prompt-editor";
import { Separator } from "@grasp-os/ui/components/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { useLingui } from "@lingui/react/macro";
import {
  ArrowUpIcon,
  PanelRightOpenIcon,
  PictureInPicture2Icon,
} from "lucide-react";
import { useRef } from "react";

import { shortcutLabel } from "../shortcuts.ts";
import { useOpenChat } from "./chat-presence.ts";
import { ComposerMenu } from "./composer-menu.tsx";
import { MentioningField } from "./composer.tsx";
import { chatKey, useGlobalChat } from "./global-chat.tsx";

// Grasp's chat while it waits (global-chat.tsx): a bar at the foot of the
// page, centred over it, as one line to ask in, which sinks away as the chat
// opens and rises back once it has gone. Its line mentions with `@` as the
// chat's box does, and its + adds a file or a mention; sending opens the
// chat where it last was, with the answer coming in, and its last button
// opens it without asking. What is typed here, chips and files too, is the
// chat's own box's, so it is all still there once the chat opens. Back, it
// takes the cursor if the chat had it.

/** How the chat opens from the bar: docked or floating, never full screen (chat-layout.ts). */
const OpenIcon = ({ placement }: { placement: DockablePlacement }) =>
  placement === "floating" ? <PictureInPicture2Icon /> : <PanelRightOpenIcon />;

/** The chat's idle bar: on every page the chat shows on, while it is closed. */
export const ChatBar = () => {
  const { t } = useLingui();
  const { placement, stage, delays, settled, composer, words, view } =
    useGlobalChat();
  const openHere = useOpenChat();
  const editor = useRef<PromptEditorHandle>(null);
  const typed = composer.text.trim() !== "";
  // Nothing to ask with (no AI provider yet): the chat opens to say so.
  const canSend = typed && (composer.models?.length ?? 0) > 0 && !composer.busy;
  const send = (): void => {
    if (canSend) {
      composer.onSend();
    }
    openHere();
  };
  const { onAttach } = composer;
  // Files show in the chat's box, which opens to show them.
  const attach =
    onAttach === undefined
      ? undefined
      : (files: readonly File[]): void => {
          onAttach(files);
          openHere();
        };
  return (
    <PromptBar
      delayed={delays.bar}
      onOpenChangeComplete={(open) => {
        // The chat closed with the cursor in it, which it lost as it went.
        if (open && document.activeElement === document.body) {
          editor.current?.focus();
        }
        settled("bar");
      }}
      open={stage.bar}
    >
      <PromptBarIcon working={view.running}>
        <GraspMark />
      </PromptBarIcon>
      <MentioningField
        describedBy={undefined}
        editor={editor}
        label={words.title}
        maxLength={undefined}
        mentions={composer.mentions}
        onBackspaceEmpty={undefined}
        onMentions={(mentions) => {
          composer.onMentions(mentions);
        }}
        onPasteFiles={attach}
        onSubmit={send}
        onText={(text) => {
          composer.onText(text);
        }}
        placeholder={words.placeholder}
        size="bar"
        text={composer.text}
      />
      <PromptBarActions>
        <ComposerMenu
          disabled={composer.busy}
          onAttach={attach}
          onMention={(mentioned, trigger) => {
            editor.current?.insertMention(mentioned, trigger);
          }}
          trigger={
            <PromptBarAction
              aria-label={t`Add`}
              disabled={composer.busy}
              variant="ghost"
            />
          }
        />
        <PromptBarAction
          aria-label={t`Send`}
          disabled={!typed}
          onClick={send}
          variant="default"
        >
          <ArrowUpIcon />
        </PromptBarAction>
        {/* As tall as the icons; as far from the filled send as the icon after it is. */}
        <div className="ms-2 flex h-4">
          <Separator orientation="vertical" />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <PromptBarAction
                aria-label={t`Open the chat`}
                onClick={() => {
                  openHere();
                }}
                variant="ghost"
              />
            }
          >
            <OpenIcon placement={placement} />
          </TooltipTrigger>
          <TooltipContent>
            {t`Open the chat`}
            <Kbd>{shortcutLabel(chatKey)}</Kbd>
          </TooltipContent>
        </Tooltip>
      </PromptBarActions>
    </PromptBar>
  );
};

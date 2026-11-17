import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";

import { ComposerAction } from "../grasp/composer/index.ts";
import { AppWindow, PanelToggle } from "../grasp/icons/index.ts";
import { shortcutLabel } from "../shortcuts.ts";
import { ChatComposer } from "./chat-composer.tsx";
import { useOpenChat } from "./chat-presence.ts";
import { chatKey, useGlobalChat } from "./global-chat.tsx";

// Grasp's chat while it waits (global-chat.tsx): the chat's one box to ask
// in (chat-composer.tsx), in one row, at the foot of the page, as one line to ask in. It mentions with
// `@` as the chat's box does, and its + adds a file or a mention; sending
// opens the chat where it last was, with the answer coming in, and its
// last button opens it without asking. What is typed here, mentions and
// files too, is the chat's own box's, so it is all still there once the
// chat opens. While Grasp answers, its light runs round it and Stop stops
// the answer. Back, it takes the cursor if the chat had it.

/** The chat's idle bar: on every page the chat shows on, while it is closed. */
export const ChatBar = () => {
  const { t } = useLingui();
  const { placement, stage, composer, words, view } = useGlobalChat();
  const openHere = useOpenChat();
  const bar = useRef<HTMLDivElement>(null);
  // Back as the chat closes: the chat had the cursor, which it lost as it
  // went. Only then: a menu or window closing elsewhere leaves the cursor
  // nowhere for a moment too, and it belongs to what opens next.
  const chatWasOpen = useRef(false);
  useEffect(() => {
    if (stage.card) {
      chatWasOpen.current = true;
      return;
    }
    if (!stage.bar) {
      return;
    }
    if (chatWasOpen.current && document.activeElement === document.body) {
      bar.current?.querySelector("textarea")?.focus();
    }
    chatWasOpen.current = false;
  }, [stage.bar, stage.card]);
  if (!stage.bar) {
    return null;
  }
  // Nothing to ask with (no AI provider yet): the chat opens to say so.
  const canSend = (composer.models?.length ?? 0) > 0 && !composer.busy;
  const shortcut = shortcutLabel(chatKey);
  const { onAttach } = composer;
  return (
    <div ref={bar}>
      <ChatComposer
        {...composer}
        footer={
          <ComposerAction
            icon={placement === "floating" ? AppWindow : PanelToggle}
            aria-label={t`Open the chat (${shortcut})`}
            onClick={() => {
              openHere();
            }}
          />
        }
        compact
        label={words.title}
        // Files show in the chat's box, which opens to show them.
        onAttach={
          onAttach === undefined
            ? undefined
            : (files) => {
                onAttach(files);
                openHere();
              }
        }
        // Opens the chat once the question went: one that didn't stays
        // here, said under the bar, to send again.
        onSend={async () => {
          if (canSend) {
            await composer.onSend();
          }
          openHere();
        }}
        placeholder={words.placeholder}
        running={view.running}
        showWorking
      />
    </div>
  );
};

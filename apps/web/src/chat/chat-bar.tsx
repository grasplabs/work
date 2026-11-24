import { Button } from "@grasp-os/ui/components/button";
import { Icon, PanelRightIcon } from "@grasp-os/ui/lib/icons";
import { duration, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { shortcutLabel } from "../shortcuts.ts";
import { closeChat, useChatLayout } from "./chat-layout.ts";
import { useChatPresence, useOpenChat } from "./chat-presence.ts";
import { Composer } from "./composer.tsx";
import { chatKey, useGlobalChat } from "./global-chat.tsx";
import { unavailableText } from "./models-unavailable.tsx";

// Grasp's chat while it waits (global-chat.tsx): a bar at the foot of the
// page, centred over it, as one row to ask in (Damsko's PromptInput,
// compact: the add menu, the text, the microphone and Send, as on #2503,
// the model too once something is typed), which
// sinks away as the chat opens and rises back once it has gone. It mentions with `@` as the chat's box does, and takes files
// pasted or dropped on it; sending opens the chat where it last was, with
// the answer coming in; the page's own bar has the button that opens it
// without asking (`ChatToggle`), as on #2503. What
// is typed here, mentions and files too, is the chat's own box's, so it is
// all still there once the chat opens. Back, it takes the cursor if the
// chat had it.

const styles = stylex.create({
  bar: {
    // The row's width, which its box answers to (composer.tsx).
    containerType: "inline-size",
    width: "100%",
    // The reference's dock: 32rem, over the middle of the page.
    maxWidth: "32rem",
    marginInline: "auto",
    paddingInline: space["2"],
    opacity: 1,
    transform: "translateY(0)",
    transitionProperty: {
      default: "opacity, transform",
      [media.reducedMotion]: "none",
    },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  // Away while the chat is open: sunk a little and out of reach.
  closed: {
    visibility: "hidden",
    opacity: 0,
    transform: "translateY(0.5rem)",
  },
  delayed: { transitionDelay: duration.stagger },
});

/** The chat's idle bar: on every page the chat shows on, while it is closed. */
export const ChatBar = () => {
  const { stage, delays, settled, composer, words, modelsUnavailable } =
    useGlobalChat();
  const unavailable = unavailableText(modelsUnavailable);
  const openHere = useOpenChat();
  const bar = useRef<HTMLDivElement>(null);
  const open = stage.bar;
  // Settled once it has risen or sunk: the chat's own moves wait for it.
  useEffect(() => {
    let current = true;
    const settle = async (): Promise<void> => {
      const element = bar.current;
      const moving = element === null ? [] : element.getAnimations();
      try {
        await Promise.all(
          moving.map(async (animation) => await animation.finished)
        );
      } catch {
        // Cut short by the next move: settled all the same.
      }
      if (!current) {
        return;
      }
      // The chat closed with the cursor in it, which it lost as it went.
      if (open && document.activeElement === document.body) {
        element?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
      }
      settled("bar");
    };
    void settle();
    return () => {
      current = false;
    };
  }, [open, settled]);
  const { onAttach } = composer;
  return (
    <div
      inert={!open}
      ref={bar}
      {...stylex.props(
        styles.bar,
        !open && styles.closed,
        delays.bar && styles.delayed
      )}
    >
      <Composer
        busy={composer.busy}
        compact
        // Out of sight while the chat is open: nothing listens from here.
        dictates={open}
        label={words.title}
        mentions={composer.mentions}
        model={composer.model}
        models={composer.models}
        onModel={(chosen) => {
          composer.onModel(chosen);
        }}
        efforts={composer.efforts}
        {...(unavailable === undefined ? {} : { unavailable })}
        onEffort={(chosen) => {
          composer.onEffort(chosen);
        }}
        {...(composer.effort === undefined ? {} : { effort: composer.effort })}
        onMentions={(mentions) => {
          composer.onMentions(mentions);
        }}
        onSend={() => {
          composer.onSend();
          openHere();
        }}
        onText={(text) => {
          composer.onText(text);
        }}
        placeholder={words.placeholder}
        running={false}
        stopNote={composer.stopNote}
        text={composer.text}
        {...(onAttach === undefined
          ? {}
          : {
              // Files show in the chat's box, which opens to show them.
              onAttach: (files: readonly File[]) => {
                onAttach(files);
                openHere();
              },
            })}
      />
    </div>
  );
};

/**
 * The chat's own button, at the end of the page's bar (frame/site-header.tsx),
 * on every page the chat may float over: it shows the chat, or hides it.
 */
export const ChatToggle = ({ style }: { style?: LayoutStyle }) => {
  const { t } = useLingui();
  const presence = useChatPresence();
  const { open } = useChatLayout();
  const openHere = useOpenChat();
  if (!presence.placements.includes("floating")) {
    return null;
  }
  return (
    <Button
      aria-label={t`Show or hide the chat`}
      onClick={() => {
        if (open) {
          closeChat();
          return;
        }
        openHere();
      }}
      size="icon-xs"
      style={style}
      title={`${t`Show or hide the chat`} (${shortcutLabel(chatKey)})`}
      variant="ghost"
    >
      <Icon icon={PanelRightIcon} />
    </Button>
  );
};

import { PromptInputButton } from "@grasp-os/ui/components/prompt-input";
import { Icon, PanelRightIcon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  duration,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { shortcutLabel } from "../shortcuts.ts";
import { useOpenChat } from "./chat-presence.ts";
import { Composer } from "./composer.tsx";
import { chatKey, useGlobalChat } from "./global-chat.tsx";
import { unavailableText } from "./models-unavailable.tsx";

// Grasp's chat while it waits (global-chat.tsx): a bar at the foot of the
// page, centred over it, as one row to ask in (Damsko's PromptInput,
// compact: the add menu, the text, the model, the microphone and Send, as
// on #2503), which
// sinks away as the chat opens and rises back once it has gone. It mentions with `@` as the chat's box does, and takes files
// pasted or dropped on it; sending opens the chat where it last was, with
// the answer coming in; the page's own bar opens it without asking
// (chat-toggle.tsx). What
// is typed here, mentions and files too, is the chat's own box's, so it is
// all still there once the chat opens. Back, it takes the cursor if the
// chat had it.

const styles = stylex.create({
  bar: {
    boxSizing: "border-box",
    width: "100%",
    // #2503's dock: 32rem at most, the box as wide as the dock, its
    // margins from a narrow window's edges round it.
    maxWidth: `calc(32rem + 2 * ${space["2"]})`,
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
  // After Send, behind a short hairline: the way to open the chat, where
  // the page has no button of its own for it (#2503's composer `after`).
  after: { display: "flex", alignItems: "center", gap: space["2"] },
  afterLine: {
    flexShrink: 0,
    width: size.hairline,
    height: size.iconSm,
    backgroundColor: {
      default: colors.border,
      [media.forcedColors]: "CanvasText",
    },
  },
});

/** The chat's idle bar: on every page the chat shows on, while it is closed. */
export const ChatBar = () => {
  const { t } = useLingui();
  const { stage, presence, composer, words, modelsUnavailable } =
    useGlobalChat();
  const unavailable = unavailableText(modelsUnavailable);
  const openHere = useOpenChat();
  const bar = useRef<HTMLDivElement>(null);
  const open = stage.bar;
  // Whether the chat was open since the bar was last here: only then does
  // it take the cursor the chat lost as it closed, never as a page opens
  // or a page's own bar first comes (#2503's).
  const chatWasOpen = useRef(false);
  useEffect(() => {
    if (stage.card) {
      chatWasOpen.current = true;
    }
  }, [stage.card]);
  // Once it has risen back, it takes the cursor the chat had.
  useEffect(() => {
    let current = true;
    const back = open && chatWasOpen.current;
    if (open) {
      chatWasOpen.current = false;
    }
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
      if (back && document.activeElement === document.body) {
        element?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
      }
    };
    void settle();
    return () => {
      current = false;
    };
  }, [open]);
  const { onAttach } = composer;
  // The page's own bar has the button that opens the chat without asking;
  // only a page whose chat is part of it (an App's workspace on a phone)
  // has none, so there the bar keeps one, or the chat's history could not
  // be reached without asking.
  const ownChat = !presence.placements.includes("floating");
  const shortcut = shortcutLabel(chatKey);
  return (
    <div
      inert={!open}
      ref={bar}
      {...stylex.props(styles.bar, !open && styles.closed)}
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
      >
        {ownChat ? (
          <div {...stylex.props(styles.after)}>
            <span aria-hidden="true" {...stylex.props(styles.afterLine)} />
            <PromptInputButton
              aria-label={t`Open the chat (${shortcut})`}
              onClick={() => {
                openHere();
              }}
            >
              <Icon icon={PanelRightIcon} />
            </PromptInputButton>
          </div>
        ) : null}
      </Composer>
    </div>
  );
};

"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useImperativeHandle, useRef } from "react";
import type { KeyboardEvent, ReactNode, Ref, RefObject } from "react";

import { Composer, ComposerAdd } from "../composer";
import type { ComposerKind, ComposerProps } from "../composer";
import { Pointer } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { Tag } from "../tag";
import { useWords, withGiven } from "../words/words";
import { pressed, readShortcut } from "./shortcut";
import { styles } from "./styles";
import { askBarWords } from "./words";
import type { AskBarWords } from "./words";

/** What a caller may style: where the bar sits and how wide it is. Never its look. */
export type AskBarLayoutStyle = LayoutStyle;

/** What a host can do to the bar from outside it, through `ref`. */
export interface AskBarHandle {
  /** Puts focus in the bar's field without scrolling anything; true when the field has it. */
  focus: () => boolean;
}

/** Every prop an AskBar takes. */
export interface AskBarProps {
  /** The name of the landmark and of its field, for a screen reader and an agent ("Ask Grasp"). It is not shown. */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** An example of what to ask ("Ask about this page"). It goes when typing starts. */
  placeholder?: string;
  /**
   * Sends the question: open the chat beside the page with it. Return a Promise and the bar waits:
   * on success the text clears, on failure it stays and `failedLabel` shows under the bar.
   */
  onSend: (text: string) => unknown;
  /**
   * The words when a send failed, shown under the bar and given to an agent.
   * @default "Could not send"
   */
  failedLabel?: string;
  /**
   * The send button's name.
   * @default "Send"
   */
  sendLabel?: string;
  /**
   * At most two quiet actions after send, behind a short hairline: ComposerAction with
   * `pressedVariant="quiet"`, such as Open the chat with the PanelToggle icon. Models, history and effort belong in the chat, never here.
   */
  actions?: ReactNode;
  /** Something small at the bar's start, after the plus, such as a mark. None by default. */
  icon?: ReactNode;
  /** Called with the files chosen from the device. Gives the plus menu its Upload attachment. */
  onAttach?: (files: File[]) => void;
  /** More things the plus menu can add, after the upload (the full composer's kinds). */
  kinds?: ComposerKind[];
  /** Called with the kind chosen from the plus menu. Target goes to `onTarget` instead. */
  onKind?: (kind: string) => void;
  /**
   * The plus button's name.
   * @default "Add to message"
   */
  addLabel?: string;
  /**
   * The upload item's words.
   * @default "Upload attachment"
   */
  uploadLabel?: string;
  /**
   * Starts picking a part of the page: the plus menu's last item, Target. Give it the `start` of
   * useTargetPicker. The plus shows only when it holds something (an upload, a kind or Target).
   */
  onTarget?: () => void;
  /**
   * The Target item's words.
   * @default "Target"
   */
  targetLabel?: string;
  /** The part of the page the question is about, as a small chip at the bar's start. The host keeps it. */
  target?: { label: string };
  /** Takes the target away: the chip's cross. Without it, the chip has none. */
  onClearTarget?: () => void;
  /** What the chip's cross says to a screen reader. "Remove" and the target's words by default. */
  clearTargetLabel?: string;
  /**
   * Turns dictation on or off: a mic in send's place while nothing is written. Once there is text
   * it is gone and send stands there. Without it, send shows as always.
   */
  onDictate?: () => void;
  /**
   * The dictate button's name.
   * @default "Dictate"
   */
  dictateLabel?: string;
  /**
   * Dictation is on: the mic shows as pressed, with the Listening icon.
   * @default false
   */
  listening?: boolean;
  /**
   * The chat is still answering: the light of the chat's own composer travels round the bar too, and
   * send turns into Stop.
   * @default false
   */
  loading?: boolean;
  /** @deprecated Use `loading`. */
  working?: boolean;
  /**
   * The words said to a screen reader while working.
   * @default "Working"
   */
  workingLabel?: string;
  /** Stops the answer. Stop shows only while `working`. */
  onStop?: () => unknown;
  /**
   * The stop button's name.
   * @default "Stop"
   */
  stopLabel?: string;
  /** The text, when you keep it in state. Pair it with `onValueChange`, and clear it in `onSend`. */
  value?: string;
  /** The text it starts with. */
  defaultValue?: string;
  /** Called with the new text and why it changed. `details.source` is `"agent"` for an agent. */
  onValueChange?: ComposerProps["onValueChange"];
  /**
   * A key that puts focus in the bar from anywhere on the page: "mod+j" (`mod` is Command on Apple
   * platforms and Control elsewhere), or a bare key such as "/", which is ignored while focus is in
   * a field. Show it to people with Kbd, near the bar.
   */
  shortcut?: string;
  /** Called when Escape leaves the field, after the field gives up focus. */
  onLeave?: () => void;
  /** Focus from outside: `focus()`. Give it the `bar` of useAskPanel. */
  ref?: Ref<AskBarHandle>;
  /** @deprecated Use `layout`. */
  style?: AskBarLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the bar. */
  layout?: AskBarLayoutStyle;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ target: "Point at the page" }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<AskBarWords>;
}

/** Puts focus in the field without scrolling anything; true when it has focus after. */
const focusField = (field: HTMLTextAreaElement | null) => {
  if (field === null) {
    return false;
  }
  field.focus({ preventScroll: true });
  return document.activeElement === field;
};

/** The global key, while the bar is on the page. */
const useShortcut = (
  shortcut: string | undefined,
  field: RefObject<HTMLTextAreaElement | null>
) => {
  useEffect(() => {
    const keys =
      shortcut === undefined || shortcut === "" ? null : readShortcut(shortcut);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (keys === null || !pressed(event, keys)) {
        return;
      }
      event.preventDefault();
      focusField(field.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [shortcut, field]);
};

/** The kind the plus menu's Target item hands on. */
const TARGET = "target";

interface StartProps {
  onAttach: AskBarProps["onAttach"];
  kinds: ComposerKind[] | undefined;
  onKind: AskBarProps["onKind"];
  addLabel: string | undefined;
  uploadLabel: string | undefined;
  onTarget: AskBarProps["onTarget"];
  targetLabel: string;
  target: AskBarProps["target"];
  onClearTarget: AskBarProps["onClearTarget"];
  clearTargetLabel: string | undefined;
  icon: ReactNode;
}

/** The bar's start: the plus menu when it holds something, the host's mark, the target's chip. */
const AskBarStart = ({
  onAttach,
  kinds,
  onKind,
  addLabel,
  uploadLabel,
  onTarget,
  targetLabel,
  target,
  onClearTarget,
  clearTargetLabel,
  icon,
}: StartProps) => {
  const all =
    onTarget === undefined
      ? (kinds ?? [])
      : [
          ...(kinds ?? []),
          { value: TARGET, label: targetLabel, icon: Pointer },
        ];
  const choose = (kind: string) => {
    if (kind === TARGET && onTarget !== undefined) {
      onTarget();
      return;
    }
    onKind?.(kind);
  };
  const plus = onAttach !== undefined || all.length > 0;
  return (
    <>
      {plus && (
        <ComposerAdd
          onAttach={onAttach}
          kinds={all}
          onKind={choose}
          aria-label={addLabel}
          uploadLabel={uploadLabel}
        />
      )}
      {icon}
      {target !== undefined && (
        <span data-slot="ask-bar-target" {...stylex.props(styles.target)}>
          <Tag
            size="sm"
            icon={Pointer}
            onRemove={onClearTarget}
            removeLabel={clearTargetLabel}
          >
            {target.label}
          </Tag>
        </span>
      )}
    </>
  );
};

/** The resting bar: the plus, a few words, dictation or send, and behind a hairline its actions. */
export const AskBar = ({
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  placeholder,
  onSend,
  failedLabel,
  sendLabel,
  actions,
  icon,
  onAttach,
  kinds,
  onKind,
  addLabel,
  uploadLabel,
  onTarget,
  targetLabel: targetGiven,
  target,
  onClearTarget,
  clearTargetLabel,
  onDictate,
  dictateLabel: dictateGiven,
  listening = false,
  working: workingDeprecated,
  loading: working = workingDeprecated ?? false,
  workingLabel,
  onStop,
  stopLabel,
  value,
  defaultValue,
  onValueChange,
  shortcut,
  onLeave,
  ref,
  style: styleProp,
  layout,
  words,
}: AskBarProps) => {
  // Its words: the product's, by its catalogue, else English; a text prop given still wins.
  const {
    target: targetLabel,
    dictate: dictateLabel,
    failed: failedWords,
    working: workingWords,
  } = withGiven(useWords("askBar", askBarWords, words), {
    target: targetGiven,
    dictate: dictateGiven,
    failed: failedLabel,
    working: workingLabel,
  });
  // The Composer's own text field, by its ref: the handle and the shortcut focus it.
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(
    ref,
    () => ({ focus: () => focusField(field.current) }),
    []
  );
  useShortcut(shortcut, field);
  // Escape that nothing inside handled (a menu, a takeover) leaves the field.
  const leave = (event: KeyboardEvent<HTMLElement>) => {
    const own = field.current;
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      own === null ||
      event.target !== own
    ) {
      return;
    }
    own.blur();
    onLeave?.();
  };
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the landmark hears Escape from its field, which the Composer leaves unhandled
    <search
      data-slot="ask-bar"
      aria-label={label}
      onKeyDown={leave}
      {...stylex.props(styles.bar, layout ?? styleProp)}
    >
      <Composer
        compact
        aria-label={label}
        placeholder={placeholder}
        failedLabel={failedWords}
        sendLabel={sendLabel}
        // The bar hands on the words only; the Composer clears what was sent on success.
        onSend={(sent) => onSend(sent)}
        activity={working ? "working" : "idle"}
        workingLabel={workingWords}
        onStop={onStop}
        stopLabel={stopLabel}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        ref={field}
        start={
          <AskBarStart
            onAttach={onAttach}
            kinds={kinds}
            onKind={onKind}
            addLabel={addLabel}
            uploadLabel={uploadLabel}
            onTarget={onTarget}
            targetLabel={targetLabel}
            target={target}
            onClearTarget={onClearTarget}
            clearTargetLabel={clearTargetLabel}
            icon={icon}
          />
        }
        onDictate={onDictate}
        dictateLabel={dictateLabel}
        listening={listening}
        listeningVariant="quiet"
        dictateWhileEmpty
        footer={actions}
      />
    </search>
  );
};

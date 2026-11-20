// Ask panel: the chat docked beside the page, which the Ask bar hands over to on send. Three rows:
// the head (AskPanelHead), the conversation (the host's Thread), and the host's full Composer at
// its foot, with its model and effort. Give it to App shell's `panels`; the shell places it, sizes
// it and covers the page with it where there is no room.
//
//   <AskPanel ref={ask.panel} label="Chat with Grasp" title={title} onNew={clear} onClose={ask.close}
//     composer={<Composer label="Message Grasp" ... />}>
//     <Thread ... />
//   </AskPanel>
//
// Escape anywhere in it that nothing inside handled closes it; Escape in a popup opened from it (a
// menu, the model picker) closes only that popup.
// Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useImperativeHandle, useRef } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";

import { AskPanelHead } from "./ask-panel-head";
import type { AskPanelHeadProps } from "./ask-panel-head";
import { focusFieldIn } from "./field";
import { styles } from "./styles";

/** Where a key belongs to an open popup, not to the panel: its field while open, or the popup itself. */
const POPUP =
  '[aria-expanded="true"], [role="menu"], [role="listbox"], [role="dialog"]';

/** What a host can do to the panel from outside it, through `ref`. */
export interface AskPanelHandle {
  /** Puts focus in the composer's field at the foot without scrolling anything; true when it has it. */
  focus: () => boolean;
}

/** Every prop an AskPanel takes: its own, and its head's. */
export interface AskPanelProps extends AskPanelHeadProps {
  /** The name of the panel, for a screen reader ("Chat with Grasp"). It is not shown. */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** The conversation: a Thread of ChatMessages. */
  children?: ReactNode;
  /** What the panel shows before anything is asked, when there are no `children`. */
  empty?: ReactNode;
  /** The composer at the foot: the full Composer, with its model and effort controls. */
  composer: ReactNode;
  /** Focus from outside: `focus()`. Give it the `panel` of useAskPanel. */
  ref?: Ref<AskPanelHandle>;
}

/** The chat beside the page: its head, the conversation, the full composer. */
export const AskPanel = ({
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  children,
  empty,
  composer,
  ref,
  onClose,
  ...head
}: AskPanelProps) => {
  const foot = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLElement>(null);
  useImperativeHandle(
    ref,
    () => ({ focus: () => focusFieldIn(foot.current) }),
    []
  );
  const close = (event: KeyboardEvent<HTMLElement>) => {
    // A key in a popup opened from the panel (the model picker, a menu) reaches here through React's
    // portal though the popup is elsewhere in the page: that Escape is the popup's, never the panel's.
    const inside =
      event.target instanceof Node &&
      own.current?.contains(event.target) === true;
    // And a popup's own field inside the panel (the model picker's search, open) closes its popup first.
    const popup =
      event.target instanceof Element && event.target.closest(POPUP) !== null;
    if (event.key === "Escape" && !event.defaultPrevented && inside && !popup) {
      event.preventDefault();
      onClose();
    }
  };
  const asked = children !== undefined && children !== null;
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the panel hears Escape that nothing inside it handled, and closes
    <section
      ref={own}
      data-slot="ask-panel"
      aria-label={label}
      onKeyDown={close}
      {...stylex.props(styles.panel)}
    >
      <AskPanelHead {...head} onClose={onClose} />
      <div data-slot="ask-panel-body" {...stylex.props(styles.body)}>
        {asked ? children : <div {...stylex.props(styles.empty)}>{empty}</div>}
      </div>
      <div ref={foot} data-slot="ask-panel-foot" {...stylex.props(styles.foot)}>
        {composer}
      </div>
    </section>
  );
};

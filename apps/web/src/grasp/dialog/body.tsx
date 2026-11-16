// DialogBody: what a dialog (dialog.tsx) is about, the one part of it that scrolls. When it holds
// more than it shows, it takes focus and is named by the dialog's title, so the keys can scroll it
// too (WCAG 2.1.1); when everything fits it is not a stop at all.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { scroll } from "../scroll/scroll";
import { dialogStyles as styles } from "./styles";
import { watchBody } from "./watch-body";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DialogBody takes. */
export interface DialogBodyProps {
  /** The task: fields, a list, words, one under another. */
  children: ReactNode;
}

/** What the dialog is about. The only part that scrolls, so the title and the actions stay put. */
export const DialogBody = ({ children }: DialogBodyProps) => {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  useEffect(() => {
    const element = box.current;
    return element === null
      ? undefined
      : watchBody(element, "dialog", setTitle, setScrolls);
  }, []);
  return (
    <div
      ref={box}
      data-slot="dialog-body"
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-labelledby={scrolls ? title : undefined}
      {...stylex.props(styles.body, scroll.bar, focus.inside)}
    >
      <div {...stylex.props(styles.stack)}>{children}</div>
    </div>
  );
};

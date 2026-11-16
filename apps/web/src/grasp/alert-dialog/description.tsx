// AlertDialogDescription: what an alert dialog (alert-dialog.tsx) says is lost. It describes the
// alert dialog, and it is the one part that scrolls: when it holds more than the window, it takes
// focus as a region named by the title, so the keys can scroll it too (WCAG 2.1.1).
"use client";

import * as stylex from "@stylexjs/stylex";
import { AlertDialogDescription as DescriptionPrimitive } from "@ui-sdk/react/alert-dialog";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useStill } from "../dialog/still-context";
import { dialogStyles } from "../dialog/styles";
import { watchBody } from "../dialog/watch-body";
import { focus } from "../focus/focus";
import { scroll } from "../scroll/scroll";
import { alertDialogStyles } from "./styles";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop an AlertDialogDescription takes. */
export interface AlertDialogDescriptionProps {
  /**
   * What is lost, said plainly: "Its 12 projects and 340 files are deleted for everyone." Read
   * with the title when it opens. One paragraph: words and inline marks, no lists or blocks.
   */
  children: ReactNode;
}

/** What is lost. It describes the alert dialog, and scrolls when it is longer than the window. */
export const AlertDialogDescription = ({
  children,
}: AlertDialogDescriptionProps) => {
  const still = useStill();
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  useEffect(() => {
    const element = box.current;
    return element === null
      ? undefined
      : watchBody(element, "alertdialog", setTitle, setScrolls);
  }, []);
  const words = stylex.props(
    dialogStyles.description,
    alertDialogStyles.description
  );
  return (
    <div
      ref={box}
      data-slot="alert-dialog-description"
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-labelledby={scrolls ? title : undefined}
      {...stylex.props(
        dialogStyles.body,
        alertDialogStyles.scroller,
        scroll.bar,
        focus.inside
      )}
    >
      {still ? (
        <p {...words}>{children}</p>
      ) : (
        <DescriptionPrimitive {...words}>{children}</DescriptionPrimitive>
      )}
    </div>
  );
};

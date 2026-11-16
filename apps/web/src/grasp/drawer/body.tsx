// DrawerBody: what a drawer (drawer.tsx) is about, the one part of it that scrolls. When it holds
// more than it shows, it takes focus and is named by the title, so the keys can scroll it too;
// when everything fits it is not a stop at all.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { scroll } from "../scroll/scroll";
import { drawerStyles as styles } from "./styles";

/** Every prop a DrawerBody takes. */
export interface DrawerBodyProps {
  /** The task: fields, a list, words, one under another. */
  children: ReactNode;
}

/** Names the body by the title, and says whether it holds more than it shows, now and on each resize. */
const watchBody = (
  element: HTMLDivElement,
  setTitle: (title: string | undefined) => void,
  setScrolls: (scrolls: boolean) => void
) => {
  setTitle(
    element.closest('[role="dialog"]')?.getAttribute("aria-labelledby") ??
      undefined
  );
  const measure = () => {
    setScrolls(element.scrollHeight > element.clientHeight + 1);
  };
  measure();
  // UI SDK's sheet keeps a focused field 16px clear of its scroll area's edge. When the body itself
  // takes focus (it does when it scrolls, on opening too) it is its own scroll area, so it was moved
  // 16px every time. Focus on the body itself goes no further than the body: the sheet's other
  // listeners act only on fields and on focus leaving it, and a field inside is still brought into
  // view as before.
  const keepPut = (event: FocusEvent) => {
    if (event.target === element) {
      event.stopPropagation();
    }
  };
  element.addEventListener("focusin", keepPut);
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  if (element.firstElementChild) {
    observer.observe(element.firstElementChild);
  }
  return () => {
    element.removeEventListener("focusin", keepPut);
    observer.disconnect();
  };
};

/** What the drawer is about. The only part that scrolls, so the title and the actions stay put. */
export const DrawerBody = ({ children }: DrawerBodyProps) => {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  useEffect(() => {
    const element = box.current;
    return element ? watchBody(element, setTitle, setScrolls) : undefined;
  }, []);
  return (
    <div
      ref={box}
      data-slot="drawer-body"
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-labelledby={scrolls ? title : undefined}
      {...stylex.props(styles.body, scroll.bar, focus.inside)}
    >
      <div {...stylex.props(styles.stack)}>{children}</div>
    </div>
  );
};

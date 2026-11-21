// The keys that fold the sidebar and open it again (Cmd+B on a Mac, Ctrl+B elsewhere, by default):
// "mod+b", "ctrl+shift+s" or "alt+\\". `mod` is Meta on Apple platforms and Control elsewhere. Not in
// rich text (contenteditable), where the same keys make text bold. Where a page holds several
// sidebars (the docs, beside their examples), one answers: the one that holds focus, else the first.
"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { RefObject } from "react";

interface Keys {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const apple = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent);

/** The keys a shortcut names. */
const read = (shortcut: string, onApple: boolean): Keys => {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  const names = new Set(parts.slice(0, -1));
  const mod = names.has("mod");
  return {
    key,
    ctrl: names.has("ctrl") || names.has("control") || (mod && !onApple),
    meta: names.has("meta") || names.has("cmd") || (mod && onApple),
    alt: names.has("alt") || names.has("option"),
    shift: names.has("shift"),
  };
};

const letterOf = (keys: Keys) =>
  keys.key.length === 1 ? keys.key.toUpperCase() : keys.key;

/** The shortcut as a person reads it ("⌘B", "Ctrl+B"). */
const shown = (keys: Keys, onApple: boolean): string => {
  if (onApple) {
    return `${keys.ctrl ? "⌃" : ""}${keys.alt ? "⌥" : ""}${keys.shift ? "⇧" : ""}${keys.meta ? "⌘" : ""}${letterOf(keys)}`;
  }
  const names: [boolean, string][] = [
    [keys.ctrl, "Ctrl"],
    [keys.meta, "Meta"],
    [keys.alt, "Alt"],
    [keys.shift, "Shift"],
  ];
  return [
    ...names.filter(([on]) => on).map(([, name]) => name),
    letterOf(keys),
  ].join("+");
};

/** The shortcut in aria-keyshortcuts' form ("Meta+B"). */
const spoken = (keys: Keys): string => {
  const names: [boolean, string][] = [
    [keys.ctrl, "Control"],
    [keys.meta, "Meta"],
    [keys.alt, "Alt"],
    [keys.shift, "Shift"],
  ];
  return [
    ...names.filter(([on]) => on).map(([, name]) => name),
    letterOf(keys),
  ].join("+");
};

const matches = (event: KeyboardEvent, keys: Keys) =>
  event.key.toLowerCase() === keys.key &&
  event.ctrlKey === keys.ctrl &&
  event.metaKey === keys.meta &&
  event.altKey === keys.alt &&
  event.shiftKey === keys.shift;

// Every sidebar listening, so that only one answers a press.
const listening = new Set<Element>();

/** The sidebar that answers: the one holding focus, else the first on the page. */
const chosen = (): Element | undefined => {
  const all = [...document.querySelectorAll("[data-slot=sidebar]")].filter(
    (element) => listening.has(element)
  );
  const active = document.activeElement;
  return (
    all.find((element) => active !== null && element.contains(active)) ?? all[0]
  );
};

/** Listens for the keys on the page; the cleanup stops listening. */
const listen = (element: HTMLElement, shortcut: string, toggle: () => void) => {
  const keys = read(shortcut, apple());
  listening.add(element);
  const press = (event: KeyboardEvent) => {
    const rich =
      event.target instanceof HTMLElement && event.target.isContentEditable;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      rich ||
      !matches(event, keys) ||
      chosen() !== element
    ) {
      return;
    }
    event.preventDefault();
    toggle();
  };
  document.addEventListener("keydown", press);
  return () => {
    listening.delete(element);
    document.removeEventListener("keydown", press);
  };
};

const noChange = () => () => {
  // Which platform it is never changes.
};

interface FoldKeysOptions {
  /** The keys, or false for none: "mod+b" when not given. */
  shortcut: string | false | undefined;
  /** No keys here (the sidebar fills a layer: the phone's menu). */
  off: boolean;
  /** The fold button's name, which the tooltip starts with. */
  label: string;
  /** The sidebar's own element. */
  aside: RefObject<HTMLElement | null>;
  /** Folds it or opens it. */
  toggle: () => void;
}

/**
 * Folds or opens the sidebar on its keys, and gives the fold buttons their tooltip ("Show or hide
 * the sidebar (⌘B)") and what a screen reader hears. The keys are shown once the browser is known:
 * on the server, and in the first draw that matches it, the tooltip is the name alone.
 */
export const useFoldKeys = ({
  shortcut: given = "mod+b",
  off,
  label,
  aside,
  toggle,
}: FoldKeysOptions) => {
  const shortcut = off ? false : given;
  const onApple = useSyncExternalStore(noChange, apple, () => null);
  useEffect(() => {
    const element = aside.current;
    return shortcut === false || shortcut === "" || element === null
      ? undefined
      : listen(element, shortcut, toggle);
  }, [shortcut, aside, toggle]);
  if (shortcut === false || shortcut === "" || onApple === null) {
    return { title: label, keys: undefined };
  }
  const keys = read(shortcut, onApple);
  return { title: `${label} (${shown(keys, onApple)})`, keys: spoken(keys) };
};

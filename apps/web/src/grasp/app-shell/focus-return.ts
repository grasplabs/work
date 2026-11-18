// When the panels close, focus goes back to what opened them: the same element if it is still
// there, else one of the same name in its place (a host's "Open the chat" drawn again once they
// close), else the bar's toggle, else the page's first stop. Never the body.
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { FOCUSABLE } from "./focus-place";

/** What a stop is called: its label, else its words. */
const nameOf = (element: HTMLElement) =>
  (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();

/** Whether focus can rest there now: in the page, drawn, and not out of reach. */
const reachable = (
  element: HTMLElement | null | undefined
): element is HTMLElement =>
  element !== null &&
  element !== undefined &&
  element.isConnected &&
  element.closest("[inert]") === null &&
  element.getClientRects().length > 0 &&
  !element.matches(":disabled");

/** The stops outside the panels, in the shell. */
const stopsOutside = (shell: HTMLElement, panels: HTMLElement | null) =>
  [...shell.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => panels?.contains(element) !== true
  );

/** Where focus goes once the panels have closed. */
const landing = (
  shell: HTMLElement,
  panels: HTMLElement | null,
  opener: HTMLElement | null,
  name: string
): HTMLElement | null => {
  if (reachable(opener) && panels?.contains(opener) !== true) {
    return opener;
  }
  const stops = stopsOutside(shell, panels);
  const same =
    name === ""
      ? undefined
      : stops.find((element) => nameOf(element) === name && reachable(element));
  const toggle = shell.querySelector<HTMLElement>(
    "[data-slot=app-shell-panels-toggle] button"
  );
  // The first stop that can take focus now: the bar's, else the page's (a phone's Menu has no box on a wide shell).
  const firstIn = (slot: string) =>
    [
      ...(shell
        .querySelector(`[data-slot=${slot}]`)
        ?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    ].find(reachable);
  return (
    [same, toggle, firstIn("app-shell-bar"), firstIn("app-shell-page")].find(
      reachable
    ) ?? null
  );
};

type Opener = RefObject<{ element: HTMLElement | null; name: string }>;

/** Notes each stop focus reaches outside the panels while they are closed. */
const noteOpener = (
  shell: HTMLElement,
  column: RefObject<HTMLElement | null>,
  isOpen: RefObject<boolean>,
  opener: Opener
) => {
  const note = (event: FocusEvent) => {
    const { target } = event;
    const panels = column.current?.querySelector(
      "[data-slot=app-shell-panels]"
    );
    if (
      !isOpen.current &&
      target instanceof HTMLElement &&
      panels?.contains(target) !== true
    ) {
      opener.current = { element: target, name: nameOf(target) };
    }
  };
  shell.addEventListener("focusin", note);
  return () => {
    shell.removeEventListener("focusin", note);
  };
};

/** After the shell has drawn the page again (so a stop the host draws once they close is there),
 * gives focus back when it was in the panels or had fallen to the body. */
const giveBackSoon = (
  shell: HTMLElement,
  column: HTMLElement,
  opener: Opener
) => {
  const panels = column.querySelector<HTMLElement>(
    "[data-slot=app-shell-panels]"
  );
  // What it goes back to may still be out of reach for a few frames (a dock coming back, the page
  // card leaving the panels' cover): try each frame until it takes focus, for as long as a move takes.
  const until = performance.now() + 1000;
  let frame = 0;
  // Focus is lost when it is on the body, in the panels going, or anywhere out of reach.
  const lost = () => {
    const now = document.activeElement;
    return (
      now === null ||
      now === document.body ||
      panels?.contains(now) === true ||
      (now instanceof HTMLElement && !reachable(now))
    );
  };
  const attempt = () => {
    if (!lost()) {
      return;
    }
    landing(
      shell,
      panels,
      opener.current.element,
      opener.current.name
    )?.focus();
    if (lost() && performance.now() < until) {
      frame = requestAnimationFrame(attempt);
    }
  };
  frame = requestAnimationFrame(attempt);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/**
 * Notes what had focus outside the panels while they were closed, and gives focus back to it when
 * they close again (their own Close, Escape, or the host turning them off), when focus was in them
 * or had fallen to the body. Noted as focus moves, not as they open: the button that opens them may
 * be gone by the time they have.
 */
export const useFocusReturn = (
  open: boolean,
  column: RefObject<HTMLElement | null>
) => {
  const opener = useRef<{ element: HTMLElement | null; name: string }>({
    element: null,
    name: "",
  });
  const isOpen = useRef(open);
  const was = useRef(open);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);
  useEffect(() => {
    const shell =
      column.current?.closest<HTMLElement>("[data-slot=app-shell]") ?? null;
    return shell === null
      ? undefined
      : noteOpener(shell, column, isOpen, opener);
  }, [column]);
  useEffect(() => {
    const closing = !open && was.current;
    was.current = open;
    const element = column.current;
    const shell =
      element?.closest<HTMLElement>("[data-slot=app-shell]") ?? null;
    return closing && shell !== null && element !== null
      ? giveBackSoon(shell, element, opener)
      : undefined;
  }, [open, column]);
};

/**
 * On a phone, where the panels lie over the page as a sheet: Escape in them sets them aside for the
 * page, as the bar's panels button does, and focus goes to that button.
 */
export const escapeSetsAside = (shell: HTMLElement, setAside: () => void) => {
  const escape = (event: KeyboardEvent) => {
    const panels = shell.querySelector("[data-slot=app-shell-panels]");
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      panels?.contains(event.target) !== true
    ) {
      return;
    }
    setAside();
    requestAnimationFrame(() => {
      shell
        .querySelector<HTMLElement>(
          "[data-slot=app-shell-panels-toggle] button"
        )
        ?.focus();
    });
  };
  shell.addEventListener("keydown", escape);
  return () => {
    shell.removeEventListener("keydown", escape);
  };
};

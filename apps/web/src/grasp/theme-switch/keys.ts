import type { KeyboardEvent } from "react";

// Where a reveal starts: the centre of the control a person pressed.
export const centreOf = (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};

/**
 * Home and End on a native radio: the browser gives the arrows, not these; they choose the first
 * or the last radio of the group, and move focus to it.
 */
export const toEnds = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Home" && event.key !== "End") {
    return;
  }
  const radios = [
    ...document.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${CSS.escape(event.currentTarget.name)}"]`
    ),
  ];
  const target = event.key === "Home" ? radios[0] : radios.at(-1);
  if (target === undefined) {
    return;
  }
  event.preventDefault();
  target.focus();
  target.click();
};

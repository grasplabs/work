// Where focus stands in the page's card, as a place among its stops. Panels coming or going draw the
// card again in a new place, so the element itself may be gone; its place is not.

/** What takes focus with Tab. */
export const FOCUSABLE =
  "button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])";

/** The element's place among the card's stops; -1 when it is not one of them. */
export const placeOf = (card: HTMLElement, element: HTMLElement): number =>
  [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].indexOf(element);

/** The first thing in the panels that takes focus: their close button first. */
export const firstStop = (panels: HTMLElement): HTMLElement | null =>
  panels.querySelector<HTMLElement>(
    "[data-slot=app-shell-panels-close] button"
  ) ?? panels.querySelector<HTMLElement>(FOCUSABLE);

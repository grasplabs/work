/** The cleanup of a ref that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** The control that opened `popup`: the one whose aria-controls names it. */
const triggerOf = (popup: HTMLElement): HTMLElement | null =>
  popup.id === ""
    ? null
    : document.querySelector<HTMLElement>(
        `[aria-controls="${CSS.escape(popup.id)}"]`
      );

/** The popup's untransformed box on the screen: its layout place, before any scale or shift. */
const boxOf = (popup: HTMLElement) => {
  const style = getComputedStyle(popup);
  // A fixed popup placed by its positioner (an inline left and top) is where they say; a scale
  // moves only its picture, never these.
  if (
    style.position === "fixed" &&
    popup.style.length > 0 &&
    (popup.style.left !== "" || popup.style.inset !== "")
  ) {
    // Computed in px ("480px"): the number before the unit.
    return {
      left: Number(style.left.slice(0, -2)),
      top: Number(style.top.slice(0, -2)),
    };
  }
  let left = popup.offsetLeft;
  let top = popup.offsetTop;
  // A fixed popup's offsets are the window's; any other adds its offset parents' places.
  const parent = popup.offsetParent;
  if (parent instanceof HTMLElement && style.position !== "fixed") {
    const box = parent.getBoundingClientRect();
    left += box.left + parent.clientLeft;
    top += box.top + parent.clientTop;
  }
  return { left, top };
};

/**
 * A ref that sets a popup's transform-origin to the centre of the trigger `findTrigger` gives (none:
 * nothing is set, and the popup keeps its positioner's origin or its own centre); again when it is
 * placed anew. For a popup whose pressed control does not name it (Combobox's chevron button).
 */
export const originFrom =
  (findTrigger: (popup: HTMLElement) => HTMLElement | null) =>
  (popup: HTMLElement | null) => {
    if (popup === null) {
      return keep;
    }
    const place = () => {
      const trigger = findTrigger(popup);
      if (trigger === null) {
        return;
      }
      const at = trigger.getBoundingClientRect();
      const box = boxOf(popup);
      const value = `${Math.round(at.left + at.width / 2 - box.left)}px ${Math.round(at.top + at.height / 2 - box.top)}px`;
      // Only when it changes: setting it is itself a change to the style the watch below reads.
      if (popup.style.transformOrigin !== value) {
        popup.style.transformOrigin = value;
      }
      // Said on the popup, so its motion can drop what would fight the origin (a dialog's rise).
      popup.dataset.fromTrigger ??= "";
    };
    place();
    // A positioned popup is placed by its inline style, which may come after this first look.
    const watch = new MutationObserver(place);
    watch.observe(popup, {
      attributes: true,
      attributeFilter: ["style", "data-side", "data-align"],
    });
    return () => {
      watch.disconnect();
    };
  };

/** Sets `popup`'s transform-origin to its trigger's centre (the control whose aria-controls names it). */
export const originFromTrigger = originFrom(triggerOf);

/** Whether a press at `at` (Date.now()) came just now: a popup that opens on it grows from what was pressed. */
export const pressedJustNow = (at: number) => Date.now() - at < 1000;

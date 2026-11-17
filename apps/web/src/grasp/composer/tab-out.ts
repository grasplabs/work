// Tab out of a popup the Composer opens beside its footer (the model and effort surface): from the
// popup's last stop, Tab closes it and goes on to the next stop after its trigger, as if the popup
// stood right after it; with nothing after the trigger (an example whose Send is off while empty),
// back on the trigger, so focus never falls to the page's body (C2, PROOF-2026-11-17.md).

const STOPS = "a[href], button, input, select, textarea, [tabindex]";

/** The elements Tab reaches in `root`, in order. */
const stopsIn = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(STOPS)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.closest("[inert], [hidden]") === null &&
      element.getClientRects().length > 0
  );

/**
 * Where Tab from `from` goes when it leaves the popup `content`, whose trigger names it with
 * aria-controls; undefined while `from` is not the popup's last stop (Tab stays inside), or when
 * Shift is held.
 */
export const tabOutTarget = (
  content: HTMLElement,
  from: EventTarget,
  shift: boolean
): HTMLElement | undefined => {
  const own = stopsIn(content);
  if (shift || own.at(-1) !== from || content.id === "") {
    return undefined;
  }
  const trigger = content.ownerDocument.querySelector<HTMLElement>(
    `[aria-controls="${CSS.escape(content.id)}"]`
  );
  if (trigger === null) {
    return undefined;
  }
  // The page's stops in order; the first after the trigger that is not the popup's own.
  const page = stopsIn(content.ownerDocument);
  const at = page.indexOf(trigger);
  const after =
    at === -1
      ? undefined
      : page.slice(at + 1).find((element) => !content.contains(element));
  return after ?? trigger;
};

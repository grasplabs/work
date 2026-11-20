// The keys of a guided flow, shared by StepFoot and StepBar: Enter is Next where focus is not in a
// field of several lines or on another button, Mod+Enter is Next anywhere in the flow, Alt+← is Back
// (Alt+→ right to left). The flow is the form round the part, else the page.
import { useEffect } from "react";
import type { RefObject } from "react";

/** Whether an Enter at this element is the field's or a button's own, not the flow's. */
const ownsEnter = (
  target: EventTarget | null,
  form: HTMLFormElement | null
) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (
    target.isContentEditable ||
    target.closest(
      "textarea, button, a[href], select, [role=button], [role=combobox], [role=menuitem], [role=option], [role=tab]"
    ) !== null
  ) {
    return true;
  }
  // In a form, Enter in a field already goes on: the form sends itself through Next.
  return form !== null && target instanceof HTMLInputElement;
};

/** A guided flow's keys, on its flow (the form round the part, else the page): Next and Back. */
export const useStepKeys = (
  on: boolean,
  foot: RefObject<HTMLDivElement | null>,
  next: RefObject<HTMLButtonElement | null>,
  back: () => void
) => {
  useEffect(() => {
    const element = foot.current;
    if (!on || element === null) {
      return () => {
        // Nothing was listened for, so nothing stops.
      };
    }
    const form = element.closest("form");
    const scope: HTMLElement | Document = form ?? element.ownerDocument;
    const press = (event: Event) => {
      if (
        !(event instanceof KeyboardEvent) ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      const rtl = getComputedStyle(element).direction === "rtl";
      if (event.altKey && event.key === (rtl ? "ArrowRight" : "ArrowLeft")) {
        event.preventDefault();
        back();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.altKey) {
        return;
      }
      const anywhere = event.metaKey || event.ctrlKey;
      if (!anywhere && ownsEnter(event.target, form)) {
        return;
      }
      event.preventDefault();
      next.current?.click();
    };
    scope.addEventListener("keydown", press);
    return () => {
      scope.removeEventListener("keydown", press);
    };
  }, [on, foot, next, back]);
};

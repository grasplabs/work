// The scrolling part of a dialog or an alert dialog (body.tsx, alert-dialog/description.tsx): it is
// named by the panel's title, and says whether it holds more than it shows, as its size changes.
"use client";

/** Watches a scroller in a panel whose role is `role`. Returns the clean-up. */
export const watchBody = (
  element: HTMLElement,
  role: "dialog" | "alertdialog",
  setTitle: (title: string | undefined) => void,
  setScrolls: (scrolls: boolean) => void
) => {
  setTitle(
    element.closest(`[role="${role}"]`)?.getAttribute("aria-labelledby") ??
      undefined
  );
  const measure = () => {
    setScrolls(element.scrollHeight > element.clientHeight + 1);
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  if (element.firstElementChild !== null) {
    observer.observe(element.firstElementChild);
  }
  return () => {
    observer.disconnect();
  };
};

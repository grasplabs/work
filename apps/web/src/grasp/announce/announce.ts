// One polite voice for the whole page: a visually hidden live region, made once on first use and
// shared by every part that says what it did ("Saved", "Copied --grasp-mint"). A part never puts a
// live region beside itself, so nothing is added next to a button in a row or a group, and two
// results never talk over each other.
//
//   announce("Saved");
"use client";

let region: HTMLElement | null = null;
let timer: ReturnType<typeof requestAnimationFrame> | undefined;

/** Says `words` once to a screen reader, politely. Does nothing on the server. */
export const announce = (words: string): void => {
  if (typeof document === "undefined") {
    return;
  }
  if (region?.isConnected !== true) {
    region = document.createElement("p");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.dataset.announce = "";
    // Visually hidden, the same way as everywhere: present to a screen reader, never seen.
    region.style.cssText =
      "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
    document.body.append(region);
  }
  const target = region;
  // Emptied first, so the same words twice in a row are said twice.
  target.textContent = "";
  if (timer !== undefined) {
    cancelAnimationFrame(timer);
  }
  timer = requestAnimationFrame(() => {
    target.textContent = words;
  });
};

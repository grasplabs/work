import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// What a page says to the person: its alerts and its toasts. Damsko's
// Toaster and the old kit's both draw each toast as one card marked
// `data-slot="toast"` with its type in `data-type`. A toast's words are
// found on that card: Damsko's region also repeats them, a moment later,
// in a hidden live region for a screen reader, where they stay, so the
// words alone match twice.

/** The toast card that shows `text`, Damsko's or the old kit's. */
export const toastSaying = (page: Page, text: string | RegExp): Locator =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

/** The error toasts on the page, Damsko's (`toast.error`) and the old kit's (`type: "error"`). */
const errorToasts = (page: Page): Locator =>
  page.locator('[data-slot="toast"][data-type="error"]');

/**
 * The page shows these errors and no other: its alerts that say something
 * say `said`, in order, and no toast is an error. An alert with nothing in
 * it says nothing: a toast region may keep an empty live region ready.
 */
export const expectErrorsShown = async (
  page: Page,
  said: readonly string[]
): Promise<void> => {
  await expect(page.getByRole("alert").filter({ hasText: /\S/u })).toHaveText([
    ...said,
  ]);
  await expect(errorToasts(page)).toHaveCount(0);
};

/** The page shows no error: no alert that says something, no error toast. */
export const expectNoError = async (page: Page): Promise<void> => {
  await expectErrorsShown(page, []);
};

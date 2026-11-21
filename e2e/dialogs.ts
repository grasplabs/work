import type { Locator, Page } from "@playwright/test";

// A dialog the page opens itself (`open`, no trigger) isn't named by its
// title yet in the library's Dialog and AlertDialog: a test finds it by its
// heading instead.

/** The open dialog, or alert dialog, titled `title`. */
export const dialogTitled = (
  page: Page,
  title: string,
  role: "dialog" | "alertdialog" = "dialog"
): Locator =>
  page
    .getByRole(role)
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

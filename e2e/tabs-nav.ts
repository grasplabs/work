import type { Locator } from "@playwright/test";

// A row of views or sections (Damsko's TabsNav) folds to one button
// with the current view where its links don't fit, as beside a docked
// chat: its menu holds the same links, and the row is out of reach then.

/** Goes to `name` from the TabsNav `nav`, folded or not. */
export const goTo = async (nav: Locator, name: string): Promise<void> => {
  const fold = nav.getByRole("button");
  const folded =
    (await fold.count()) > 0 &&
    (await fold.evaluate((button) => button.closest("[inert]") === null));
  if (!folded) {
    await nav.getByRole("link", { name }).click();
    return;
  }
  await fold.click();
  await nav.page().getByRole("menuitem", { name }).click();
};

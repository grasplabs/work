import type { Locator, Page } from "@playwright/test";

// The chat docked beside a page is a region named after its chat, which
// changes once the chat has a title (apps/web/src/chat/chat-panel.tsx), so a
// test finds it by its box instead: on an App or a workflow, the box is
// "Ask for a change".

/** The docked chat whose box is `box`. */
export const dockedChat = (page: Page, box = "Ask for a change"): Locator =>
  page
    .getByRole("region")
    .filter({ has: page.getByRole("form", { name: box, exact: true }) });

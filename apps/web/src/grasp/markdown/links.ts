// A part that holds Markdown can draw some of its links itself: Sources draws a `cite:` link as its
// Citation, so no page writes a renderLink for it. Markdown asks the page's own `renderLink` first,
// then the part around it; a link neither draws is Markdown's own.
"use client";

import { createContext } from "react";

import type { MarkdownDrawn, MarkdownLink } from "./markdown";

/** Draws a link in Markdown's place, or gives undefined to leave it to Markdown. */
export type MarkdownLinkDrawer = (
  link: MarkdownLink
) => MarkdownDrawn | undefined;

/** The links a part around Markdown draws (Sources: its citations). */
export const MarkdownLinks = createContext<MarkdownLinkDrawer | null>(null);

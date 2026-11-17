import { createContext, use } from "react";
import type { ReactNode } from "react";

// What the frame says over every page (the AI-key banner): under the
// page's own bar, which SiteHeader draws, so App shell's Menu button at the
// card's top on a phone never stands over it. App shell has no place above
// the page's bar for it yet.

const FrameBannerContext = createContext<ReactNode>(null);

export const FrameBanner = FrameBannerContext.Provider;

/** The frame's banner, for the page's bar to show under it. */
export const useFrameBanner = (): ReactNode => use(FrameBannerContext);

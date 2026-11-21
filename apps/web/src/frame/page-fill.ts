import { useMatches } from "@tanstack/react-router";

// Pages that fill the page's card and scroll inside their own panes (an
// App's or a workflow's shell, Knowledge, the Brain, an
// App's page in its frame) say so on their route:
//
//   export const Route = createFileRoute("/_shell/brain")({
//     staticData: { page: "fill" },
//   });
//
// The frame then holds them to the card's height (frame/app-frame.tsx),
// where any other page grows as long as it is and scrolls in the card.
//
// A page that lays out a side panel of its own (an app beside the
// Integrations' lists) says `page: "whole"`: it fills the card and has it
// edge to edge, with no side room, so its panel stands flush with the bar,
// the card's end and the card's foot, as the library's inspector pattern
// seats it. Such a page keeps its own inset for everything but the panel.
//
// A page that failed has the whole card too, whatever its route says: its
// backdrop (frame/page-failed.tsx) stands from under the bar down to the
// card's foot, behind the chat's bar, not inset like a page's words.

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page fills the card and scrolls inside its own panes (frame/page-fill.ts). */
    page?: "fill" | "whole";
    /**
     * `false`: no chat box at the card's foot while the page shows, for a
     * page that takes someone through a task of its own (New agent).
     */
    dock?: false;
  }
}

/** Whether the page shown fills the card: any of its routes says so, or one failed. */
export const usePageFills = (): boolean =>
  useMatches().some(
    ({ staticData, status }) =>
      staticData.page !== undefined || status === "error"
  );

/** Whether the page shown has the whole card, edge to edge: any of its routes says so, or one failed. */
export const usePageWhole = (): boolean =>
  useMatches().some(
    ({ staticData, status }) =>
      staticData.page === "whole" || status === "error"
  );

/** Whether the page shown keeps the chat box at the card's foot: none of its routes says no. */
export const usePageDock = (): boolean =>
  !useMatches().some(({ staticData }) => staticData.dock === false);

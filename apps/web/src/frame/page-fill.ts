import { useMatches } from "@tanstack/react-router";

// Pages that fill the page's card and scroll inside their own panes (an
// App's or a workflow's shell, the inbox's split, Knowledge, the Brain, an
// App's page in its frame) say so on their route:
//
//   export const Route = createFileRoute("/_shell/inbox")({
//     staticData: { page: "fill" },
//   });
//
// The frame then holds them to the card's height (frame/app-frame.tsx),
// where any other page grows as long as it is and scrolls in the card.
//
// A page with a side panel of its own (the Inbox's inspector, a note's
// details in the Brain) says `page: "whole"`: it fills the card and has it
// edge to edge, with no side room, so its panel stands flush with the bar,
// the card's end and the card's foot, as the library's inspector pattern
// seats it. Such a page keeps its own inset for everything but the panel.

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page fills the card and scrolls inside its own panes (frame/page-fill.ts). */
    page?: "fill" | "whole";
  }
}

/** Whether the page shown fills the card: any of its routes says so. */
export const usePageFills = (): boolean =>
  useMatches().some(({ staticData }) => staticData.page !== undefined);

/** Whether the page shown has the whole card, edge to edge: any of its routes says so. */
export const usePageWhole = (): boolean =>
  useMatches().some(({ staticData }) => staticData.page === "whole");

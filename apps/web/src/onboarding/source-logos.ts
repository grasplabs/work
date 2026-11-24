import { filledMark } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

import { GoogleLogo, MicrosoftLogo } from "../connections/brand-logos.ts";
import type { DocumentSource } from "./setup.ts";

// The marks of the places documents live, for the sources step: a suite's
// places carry the suite's own mark (Microsoft's SharePoint, OneDrive and
// Teams, Google's Drive), as their sign-in does; the others their own,
// filled and in their own colour, never a line redraw. Vendored from
// Simple Icons 16.36.0 (CC0, simpleicons.org): confluence.svg and
// notion.svg, on the 24 grid as drawn there. Confluence in Atlassian's
// published blue; Notion follows the ink, as Notion draws itself. A
// place asked for by name gets a page, and the row to name one a plus.

/** Confluence. */
const ConfluenceLogo: IconData = filledMark([
  [
    "path",
    {
      key: "confluence",
      d: "M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.337a.764.764 0 0 0 1.028-.382l2.364-5.346a.764.764 0 0 0-.382-1 599.851 599.851 0 0 1-4.965-2.361C10.911 10.97 5.224 11.185.87 18.257zM23.131 5.743c.249-.405.531-.875.764-1.25a.764.764 0 0 0-.256-1.034L18.675.404a.764.764 0 0 0-1.058.26c-.195.335-.451.763-.734 1.225-1.966 3.246-3.945 2.85-7.508 1.146L4.437.694a.764.764 0 0 0-1.027.382L1.046 6.422a.764.764 0 0 0 .382 1c1.039.49 3.105 1.467 4.965 2.361 6.698 3.246 12.392 3.029 16.738-4.04z",
      fill: "#1868DB",
    },
  ],
]);

/** Notion. */
const NotionLogo: IconData = filledMark([
  [
    "path",
    {
      key: "notion",
      d: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
      fill: "currentColor",
    },
  ],
]);

/** A place asked for by name, which has no mark Grasp knows: a page, in the ink. */
export const wantedLogo: IconData = filledMark([
  ["path", { key: "page", d: "M5 2h9l5 5v15H5z", fill: "currentColor" }],
]);

/** Another place, to be named: a plus, in the ink. */
export const otherLogo: IconData = filledMark([
  [
    "path",
    {
      key: "plus",
      d: "M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z",
      fill: "currentColor",
    },
  ],
]);

/** The mark a place carries: its suite's, or its own. */
export const sourceLogo = (source: DocumentSource): IconData | null => {
  if (source.suite === "microsoft") {
    return MicrosoftLogo;
  }
  if (source.suite === "google") {
    return GoogleLogo;
  }
  if (source.id === "confluence") {
    return ConfluenceLogo;
  }
  return source.id === "notion" ? NotionLogo : null;
};

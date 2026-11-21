// Where a pane stands when a place draws its frame for it: App shell's page panel seats what it
// holds beside the page (flush with the card) or, on a narrow card, in its sheet. A Panel reads it:
// seated, it is unframed unless `framed` is given, and in the sheet its head leaves out its close
// button, since the sheet's own closes it. Shared, so the place that seats a pane and the pane it
// seats never import each other.
import { createContext } from "react";

/** The place that seats the pane: none, beside the page, or a sheet with its own close. */
export type PanelSeat = "none" | "beside" | "sheet";

/** Where the pane stands. */
export const PanelSeated = createContext<PanelSeat>("none");

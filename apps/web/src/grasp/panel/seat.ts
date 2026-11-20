// Where a Panel stands when a place draws its frame for it: App shell's page panel, beside the page
// (flush with the card) or as its sheet on a narrow card. There a Panel is unframed unless `framed`
// is given, and in the sheet its head leaves out its close button: the sheet's own closes it.
import { createContext } from "react";

/** The place that seats the Panel: none, beside the page, or a sheet with its own close. */
export type PanelSeat = "none" | "beside" | "sheet";

/** Where the Panel stands. */
export const PanelSeated = createContext<PanelSeat>("none");

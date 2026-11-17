// Where a TabsLink is drawn (nav.tsx). A TabsNav draws its children four times: in the row; unseen,
// for its width; as the fold's menu items; and on the fold's button, where only the current one
// shows its words.
import { createContext } from "react";

export type Place = "row" | "ghost" | "menu" | "trigger";

export const PlaceContext = createContext<Place>("row");

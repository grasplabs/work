// Whether the parts stand in a drawer (a grip at the top) or a sheet (a close button in the
// corner), so a title leaves room for what is beside or above it.
import { createContext, useContext } from "react";

export const KindContext = createContext<"drawer" | "sheet">("drawer");
export const useKind = () => useContext(KindContext);

// Whether the drawer has heights to rest at: then the panel takes its tallest height, so it has
// room to rise into, and the lower rests show part of it.
export const SnapsContext = createContext(false);
export const useSnaps = () => useContext(SnapsContext);

// How wide a sheet is (sheet.tsx), for its panel (panel.tsx).
import { createContext, useContext } from "react";

export const SizeContext = createContext<"md" | "wide" | "full">("md");
export const useSize = () => useContext(SizeContext);

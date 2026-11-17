// How wide a dialog is (dialog.tsx), for its panel (panel.tsx).
import { createContext, useContext } from "react";

export const SizeContext = createContext<"md" | "full">("md");
export const useSize = () => useContext(SizeContext);

// What a ToggleGroup tells the toggles inside it: that they sit on its track, and at which size.
import { createContext } from "react";

export type ToggleSize = "md" | "sm";

export const ToggleGroupContext = createContext<{
  grouped: boolean;
  size: ToggleSize;
}>({
  grouped: false,
  size: "md",
});

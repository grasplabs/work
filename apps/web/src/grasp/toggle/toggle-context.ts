// What a ToggleGroup tells the toggles inside it: that they sit on its track, and at which size.
import { createContext } from "react";

/** Button's ladder: xs 28 (control-xs), sm 32, md 36, lg 44, so a toggle stands level with a field of its size. */
export type ToggleSize = "xs" | "sm" | "md" | "lg";

export const ToggleGroupContext = createContext<{
  grouped: boolean;
  size: ToggleSize;
}>({
  grouped: false,
  size: "xs",
});

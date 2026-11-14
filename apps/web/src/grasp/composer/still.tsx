// ComposerStill: a Composer drawn standing still, for the docs' every-state row (still-context.ts).
// Not exported from the component's index: a product never needs a still composer.
import type { ReactNode } from "react";

import { StillContext } from "./still-context";

/** Holds every composer inside it still: the light where it is, the halo at its brightest. */
export const ComposerStill = ({ children }: { children: ReactNode }) => (
  <StillContext.Provider value>{children}</StillContext.Provider>
);

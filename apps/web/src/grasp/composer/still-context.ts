// For the docs' every-state row only: a composer drawn standing still. Its working light holds
// where it is and its success halo holds at its brightest, so a state can be seen and measured.
// The shipped index does not export it.
import { createContext, useContext } from "react";

export const StillContext = createContext(false);

export const useStill = () => useContext(StillContext);

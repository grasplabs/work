import { createContext } from "react";

/**
 * Whether what renders is inside the signed-in frame (the app's sidebar
 * beside the page): only there can a page show the site header, whose
 * trigger needs the sidebar. A page's own loading, error or not-found state
 * renders inside the frame; the shell's own (core out of reach), and pages
 * outside it such as sign-in, don't.
 */
export const InFrame = createContext(false);

import { useState, useSyncExternalStore } from "react";

import { keepFolded, readFolded } from "../fold.ts";

// Whether a page's sidebar (`PageSidebar` in the kit) is folded, as the
// person left it in this browser. The sidebar itself is the kit's, the
// same as the admin's column beside an organization.

/** From this width the window holds the app's sidebar, a page sidebar and the page side by side; narrower, a page sidebar starts folded. */
const roomyQuery = "(min-width: 1280px)";

const onRoomy = (onChange: () => void): (() => void) => {
  const query = matchMedia(roomyQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

const isRoomy = (): boolean => matchMedia(roomyQuery).matches;

/**
 * Whether a page's sidebar is folded, kept as the person left it in this
 * browser (a cookie, `page` naming it, e.g. "chat"). Until they choose, it
 * is open on a roomy window and folded on a narrow one.
 */
export const usePageSidebarFold = (
  page: string
): [boolean, (folded: boolean) => void] => {
  const roomy = useSyncExternalStore(onRoomy, isRoomy);
  const [choice, setChoice] = useState(() => readFolded(page));
  const setFolded = (folded: boolean): void => {
    setChoice(folded);
    void keepFolded(page, folded);
  };
  return [choice ?? !roomy, setFolded];
};

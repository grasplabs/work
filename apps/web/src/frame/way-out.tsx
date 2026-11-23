import { Link, useLocation } from "@tanstack/react-router";
import type { AnchorHTMLAttributes } from "react";
import { useState } from "react";

import { levelAt } from "./levels.ts";

// Back, in a level of the sidebar (Settings), leads out of every level, to
// the last page the main level stood beside; to Chat when the person
// landed in a level. Kept while the sidebar is, which keeps every level in
// the page.

/** A page the main level stands beside, to go back to. */
interface Outside {
  pathname: string;
  search: Record<string, unknown>;
}

/**
 * The way out of a level: a link to the last page outside every level. It
 * takes what a part drawing it as its child (`asChild`) gives it.
 */
export const WayOut = ({
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) => {
  const { pathname, search } = useLocation();
  const [outside, setOutside] = useState<Outside>();
  if (levelAt(pathname) === "main" && outside?.pathname !== pathname) {
    setOutside({ pathname, search });
  }
  return outside === undefined ? (
    <Link {...rest} to="/">
      {children}
    </Link>
  ) : (
    <Link {...rest} search={outside.search} to={outside.pathname}>
      {children}
    </Link>
  );
};

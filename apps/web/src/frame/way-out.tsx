import { Link, useLocation } from "@tanstack/react-router";
import type { AnchorHTMLAttributes } from "react";
import { useState } from "react";

import { inLevel } from "./levels.ts";

// Back, in a level of the sidebar (Settings, the Brain, an App), leads out of every level, to
// the last page the main level stood beside; to Chat when the person
// landed in a level. The frame keeps that page (`useWayOut`, in the
// sidebar's own component, which stays as long as the frame does): the
// levels' rows are drawn anew each time the phone's sheet opens.

/** A page the main level stands beside, to go back to, as the person left it. */
export interface Outside {
  /** The whole address, its query with it: a new query is a new place. */
  href: string;
  pathname: string;
  search: Record<string, unknown>;
}

/**
 * The last page outside every level, followed as the person goes; none
 * yet when they landed in a level. Call it where it stays while the frame
 * does.
 */
export const useWayOut = (): Outside | undefined => {
  const { href, pathname, search } = useLocation();
  const [outside, setOutside] = useState<Outside>();
  if (!inLevel(pathname) && outside?.href !== href) {
    setOutside({ href, pathname, search });
  }
  return outside;
};

/**
 * The way out of a level: a link to `outside`, the last page outside every
 * level (`useWayOut`), or to Chat. It takes what a part drawing it as its
 * child (`asChild`) gives it.
 */
export const WayOut = ({
  outside,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  outside: Outside | undefined;
}) =>
  outside === undefined ? (
    <Link {...rest} to="/">
      {children}
    </Link>
  ) : (
    <Link {...rest} search={outside.search} to={outside.pathname}>
      {children}
    </Link>
  );

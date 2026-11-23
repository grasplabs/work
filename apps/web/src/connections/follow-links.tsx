import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";

// The app parts link with plain anchors (an app's Settings, All
// tools, a workflow that uses it). A plain press on one of this page's own
// addresses moves the router instead, so the app doesn't load again; a
// press for a new tab or window, or a download, stays the browser's.
// React's events pass through a portal, so this holds for a Sheet's
// content too.

const styles = stylex.create({
  // No box of its own: what it holds lays out as if it stood there itself.
  contents: { display: "contents" },
});

/** The address a plain press on a link of this page's own goes to; none for any other press. */
const ownAddressOf = (event: MouseEvent): string | undefined => {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !(event.target instanceof Element)
  ) {
    return undefined;
  }
  const link = event.target.closest("a[href]");
  if (
    !(link instanceof HTMLAnchorElement) ||
    link.hasAttribute("download") ||
    (link.target !== "" && link.target !== "_self")
  ) {
    return undefined;
  }
  const url = new URL(link.href, window.location.href);
  return url.origin === window.location.origin
    ? `${url.pathname}${url.search}${url.hash}`
    : undefined;
};

/** Follows a press on a link inside it with the router. */
export const FollowLinks = ({ children }: { children: ReactNode }) => {
  const router = useRouter();
  return (
    <div
      onClickCapture={(event) => {
        const href = ownAddressOf(event);
        if (href !== undefined) {
          event.preventDefault();
          void router.navigate({ href });
        }
      }}
      {...stylex.props(styles.contents)}
    >
      {children}
    </div>
  );
};

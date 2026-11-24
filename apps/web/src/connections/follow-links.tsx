import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { createContext, use } from "react";
import type { MouseEvent, ReactNode } from "react";

// The library's app parts link with plain anchors (an app's Settings, All
// tools, a workflow that uses it). A plain press on one of this page's own
// addresses moves the router instead, so the app doesn't load again; a
// press for a new tab or window, or a download, stays the browser's.
// React's events pass through a portal, so this holds for a Sheet's
// content too. A row that is a button and goes somewhere (a workflow that
// uses the app) follows its address the same way (`useFollow`).

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

/** Whether a press asks for a new tab or window. */
const elsewhere = (event: MouseEvent): boolean =>
  event.metaKey || event.ctrlKey || event.shiftKey;

/** Goes to `href` for a press: in a new tab where the press asks for one, else here. */
type Follow = (href: string, event: MouseEvent) => void;

const FollowContext = createContext<Follow>((href, event) => {
  if (elsewhere(event)) {
    window.open(href, "_blank", "noopener");
  } else {
    window.location.assign(href);
  }
});

/** How a press on a row that goes to an address follows it: with the router inside FollowLinks. */
export const useFollow = (): Follow => use(FollowContext);

/** Follows a press on a link inside it, or on a row that goes somewhere, with the router. */
export const FollowLinks = ({ children }: { children: ReactNode }) => {
  const router = useRouter();
  const follow: Follow = (href, event) => {
    if (elsewhere(event)) {
      window.open(href, "_blank", "noopener");
    } else {
      void router.navigate({ href });
    }
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <FollowContext value={follow}>
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
    </FollowContext>
  );
};

import { useNavigate } from "@tanstack/react-router";

/**
 * A ref for the box around text the library draws (DocumentEditor): a click on a link to another page of Grasp
 * opens it in place, as the app's own links do, instead of loading the whole app again, and a link out of
 * Grasp opens in a new tab. A new tab or window the reader asks for stays the browser's.
 */
export const useFollowLinks = () => {
  const navigate = useNavigate();
  return (element: HTMLDivElement) => {
    const follow = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (
        link === null ||
        (link.protocol !== "http:" && link.protocol !== "https:") ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      // A link out of Grasp opens in a tab of its own, without this page as its opener.
      if (link.origin !== window.location.origin) {
        window.open(link.href, "_blank", "noopener,noreferrer");
        return;
      }
      void navigate({ href: `${link.pathname}${link.search}${link.hash}` });
    };
    element.addEventListener("click", follow);
    return () => {
      element.removeEventListener("click", follow);
    };
  };
};

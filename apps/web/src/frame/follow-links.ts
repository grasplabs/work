import { useNavigate } from "@tanstack/react-router";

/**
 * A ref for the box around text the library draws (DocumentEditor): a click on a link to another page of Grasp
 * opens it in place, as the app's own links do, instead of loading the whole app again. A new tab
 * or window stays the browser's.
 */
export const useFollowLinks = () => {
  const navigate = useNavigate();
  return (element: HTMLDivElement) => {
    const follow = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (
        link === null ||
        link.origin !== window.location.origin ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      void navigate({ href: `${link.pathname}${link.search}${link.hash}` });
    };
    element.addEventListener("click", follow);
    return () => {
      element.removeEventListener("click", follow);
    };
  };
};

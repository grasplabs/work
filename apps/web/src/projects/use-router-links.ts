import { useRouter } from "@tanstack/react-router";

// Grasp UI's Item leads somewhere by a plain `href` alone, with no way to
// hand it the router's link (grasp/item/item.tsx), so a click on it would
// load the whole app again. Inside the element this ref is on, a plain
// click on a link to a page of Grasp goes through the router instead; a
// click with a key held, or on a link elsewhere, is the browser's.

/** A ref (React's, with its cleanup) for the element whose links the router follows. */
export const useRouterLinks = () => {
  const router = useRouter();
  const follow = (host: HTMLElement) => {
    const onClick = (event: MouseEvent) => {
      const withKey =
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (event.defaultPrevented || event.button !== 0 || withKey) {
        return;
      }
      const link =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (
        link === null ||
        link.target !== "" ||
        link.origin !== window.location.origin
      ) {
        return;
      }
      event.preventDefault();
      void router.navigate({
        href: `${link.pathname}${link.search}${link.hash}`,
      });
    };
    host.addEventListener("click", onClick);
    return () => {
      host.removeEventListener("click", onClick);
    };
  };
  return (host: HTMLElement | null) =>
    host === null ? undefined : follow(host);
};

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

/**
 * For the box around text the library draws (DocumentEditor): a plain click
 * on a link to another page of Grasp opens it in place, as the app's own
 * links do, instead of loading the whole app again; a new tab or window the
 * reader asks for there stays the browser's. Any click on a link out of
 * Grasp, a middle click too, waits for the person's yes (`leaving`, for
 * `LeaveConfirm`), as a link in an answer does: a note's text may come
 * from a source or a chat.
 */
export const useFollowLinks = (): {
  /** The box's ref. */
  follow: (element: HTMLDivElement) => () => void;
  /** The link out of Grasp waiting for the person's yes. */
  leaving: string | undefined;
  stopLeaving: () => void;
} => {
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState<string>();
  return {
    follow: (element) => {
      const follow = (event: MouseEvent) => {
        const link =
          event.target instanceof Element ? event.target.closest("a") : null;
        if (
          link === null ||
          (link.protocol !== "http:" && link.protocol !== "https:")
        ) {
          return;
        }
        if (link.origin !== window.location.origin) {
          event.preventDefault();
          setLeaving(link.href);
          return;
        }
        if (
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
      element.addEventListener("auxclick", follow);
      return () => {
        element.removeEventListener("click", follow);
        element.removeEventListener("auxclick", follow);
      };
    },
    leaving,
    stopLeaving: () => {
      setLeaving(undefined);
    },
  };
};

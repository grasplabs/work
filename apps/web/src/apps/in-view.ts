import { useEffect, useState } from "react";

// Whether an element is on screen, for the Apps page's cards: a card's
// window runs its App only while the card is in view, so a long page of
// Apps never runs them all at once. Work's own until Grasp UI's App card
// does this itself.

/**
 * Watches the element given to `watch`: `inView` while any of it is on
 * screen, false before it was measured and once it has left.
 */
export const useInView = (): {
  watch: (element: Element | null) => void;
  inView: boolean;
} => {
  const [element, setElement] = useState<Element | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      // The latest of what it saw: several come at once after a fast scroll.
      const last = entries.at(-1);
      if (last !== undefined) {
        setInView(last.isIntersecting);
      }
    });
    if (element !== null) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return { watch: setElement, inView };
};

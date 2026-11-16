// useArriving: the words written into a box fade in as they arrive, with nothing round any word
// (arrive-highlight.ts). A Chat message does it for its words, and Markdown for its own when it
// stands alone; a part that paces words itself (usePaced) inside a Chat message needs nothing more.
//
//   const [box, setBox] = useState<HTMLElement | null>(null);
//   useArriving(box, streaming);
//   <p ref={setBox}>{paced.text}</p>
//
// While `live`, text added inside the box fades in from the frame it is drawn. When `live` ends,
// what is fading finishes and nothing more is marked. Reduced motion, forced colours, or a browser
// without the Custom Highlight API: nothing fades, the words simply appear.
"use client";

import { useEffect } from "react";

import { settleFading, startFading } from "./arrive-highlight";

export const useArriving = (box: HTMLElement | null, live: boolean) => {
  useEffect(() => {
    const fader = box !== null && live ? startFading(box) : null;
    return () => {
      settleFading(fader);
    };
  }, [box, live]);
};

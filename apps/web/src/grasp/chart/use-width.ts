// How wide a box is drawn, in CSS pixels, kept as it changes: for the chart parts that draw their
// own SVG and need whole pixels (a dither's cells sit on them). Until the box is laid out it is 0,
// and a part draws nothing yet, but keeps its room.
"use client";

import { useState } from "react";

export const useWidth = (): [
  number,
  (element: Element | null) => () => void,
] => {
  const [width, setWidth] = useState(0);
  // A ref callback: it watches the box while it is there and stops when it goes.
  const watch = (element: Element | null) => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) {
        setWidth(Math.floor(entry.contentRect.width));
      }
    });
    if (element !== null) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  };
  return [width, watch];
};

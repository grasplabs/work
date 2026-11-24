// Runs long: whether an input's value is longer than the input shows, so a field fades the value
// at its end only then, and every letter of a value that fits stays at full ink.
//
//   const { setInput, long } = useRunsLong();
//   <input ref={setInput} {...stylex.props(styles.input, !long && styles.fits)} />
//
// Read on typing, on leaving the field (a value set from code is read then too), and on a resize.
"use client";

import { useEffect, useState } from "react";

/** Whether an input's value is longer than the input shows. */
const overflows = (input: HTMLInputElement) =>
  input.scrollWidth > input.clientWidth + 1;

/**
 * Watches an input for a value longer than it shows. Returns `setInput`, to call with the input
 * element, and whether the value runs long.
 */
export const useRunsLong = () => {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const measure = () => {
      if (input !== null) {
        setLong(overflows(input));
      }
    };
    measure();
    input?.addEventListener("input", measure);
    input?.addEventListener("focusout", measure);
    const observer =
      input === null || typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (input !== null) {
      observer?.observe(input);
    }
    return () => {
      input?.removeEventListener("input", measure);
      input?.removeEventListener("focusout", measure);
      observer?.disconnect();
    };
  }, [input]);
  return { setInput, long };
};

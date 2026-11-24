import { useEffect, useState } from "react";

/**
 * `value` once it stayed the same for `ms`: what a search box hands its
 * query, so typing reads one query rather than one per key.
 */
export const useSettled = <Value>(value: Value, ms: number): Value => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
};

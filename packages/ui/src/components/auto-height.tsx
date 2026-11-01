// A box whose height eases to fit what is inside, and content that fades in
// from just below, so a dialog glides instead of jumping when its step
// changes. Ported from the prototype's `components/auto-height.tsx`
// (grasplabs/prototype, ddd235d4): the same easing and timings. Where the
// kit differs:
// - with reduced motion nothing moves: the height and the content change
//   at once;
// - `FadeIn` is a component rather than props to spread on motion's own,
//   so screens need no motion import of their own.
import { cn } from "@grasp-os/ui/lib/utils";
import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

const ease = [0.23, 1, 0.32, 1] as const;

/** The height eases to fit its children; nothing inside is stretched. */
function AutoHeight({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setHeight(
          entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height
        );
      }
    });
    if (inner.current !== null) {
      observer.observe(inner.current);
    }
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <motion.div
      animate={{ height }}
      className="-m-1 overflow-hidden"
      data-slot="auto-height"
      initial={false}
      transition={reduce === true ? { duration: 0 } : { duration: 0.28, ease }}
    >
      {/* A little room around the edge keeps focus rings visible. */}
      <div className={cn("p-1", className)} ref={inner}>
        {children}
      </div>
    </motion.div>
  );
}

/**
 * Fades its children in from just below as it appears. It owns no layout:
 * lay out what is inside it.
 */
function FadeIn({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      data-slot="fade-in"
      initial={reduce === true ? false : { opacity: 0, y: 8 }}
      transition={{ duration: 0.22, ease }}
    >
      {children}
    </motion.div>
  );
}

export { AutoHeight, FadeIn };

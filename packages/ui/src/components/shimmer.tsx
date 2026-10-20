// Text with a light that sweeps across it, for what is still being worked
// out ("Thinking…"). Ported from the prototype's AI Elements shimmer
// (grasplabs/prototype `components/ai-elements/shimmer.tsx`, ddd235d):
// the same markup, classes and motion. Where the kit differs:
// - the gradient is in the classes, on the theme's `background` and
//   `muted-foreground`, not in an inline style; only the sweep's width,
//   which follows the text's length, is a custom property motion sets;
// - it renders as a paragraph, a span or a div, motion's own components,
//   rather than one made per tag;
// - no hand-written memo: the React Compiler memoises it;
// - with reduced motion the text stands still, in `muted-foreground`,
//   by a `motion-reduce` class, so server and client render the same.
import { cn } from "@grasp-os/ui/lib/utils";
import { motion } from "motion/react";

/** The tags it renders as, each motion's own component. */
const motionTags = {
  p: motion.p,
  span: motion.span,
  div: motion.div,
} as const;

/**
 * The element's own attributes (`role`, `aria-live`, …), less what motion
 * handles itself and the inline style the kit doesn't take.
 */
type ElementProps = Omit<
  React.HTMLAttributes<HTMLElement>,
  | "children"
  | "className"
  | "style"
  | "onAnimationStart"
  | "onDrag"
  | "onDragEnd"
  | "onDragStart"
>;

interface ShimmerProps extends ElementProps {
  children: string;
  /** The element it renders as; a paragraph by default. */
  as?: keyof typeof motionTags;
  className?: string;
  /** Seconds one sweep takes. */
  duration?: number;
  /** How wide the light is, in pixels per character of the text. */
  spread?: number;
}

function Shimmer({
  children,
  as = "p",
  className,
  duration = 2,
  spread = 2,
  ...props
}: ShimmerProps) {
  const MotionComponent = motionTags[as];
  // The sweep's width follows the text's length: a custom property,
  // set by motion with the position it animates.
  const width = `${children.length * spread}px`;
  return (
    <MotionComponent
      {...props}
      data-slot="shimmer"
      animate={{ backgroundPosition: "0% center", "--spread": width }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[background-repeat:no-repeat] [--bg:linear-gradient(90deg,transparent_calc(50%-var(--spread)),var(--color-background),transparent_calc(50%+var(--spread)))]",
        "bg-[image:var(--bg),linear-gradient(var(--color-muted-foreground),var(--color-muted-foreground))]",
        // Reduced motion in CSS, not a hook: the server's markup and the
        // first client render are the same either way.
        "motion-reduce:text-muted-foreground motion-reduce:bg-none",
        className
      )}
      initial={{ backgroundPosition: "100% center", "--spread": width }}
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
}

export { Shimmer };

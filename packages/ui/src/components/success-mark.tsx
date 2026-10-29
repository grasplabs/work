// A check that lands with a pulse, for a step that went through: a badge
// pops in, its check draws, a soft ring spreads out. Ported from the
// prototype's `components/success-mark.tsx` (grasplabs/prototype,
// ddd235d4), on the theme's tokens. With reduced motion it stands still,
// drawn as it ends.
import { motion, useReducedMotion } from "motion/react";

const ease = [0.23, 1, 0.32, 1] as const;

/** Decorative: say what succeeded in text beside it. */
function SuccessMark() {
  const reduce = useReducedMotion() === true;
  return (
    <span
      aria-hidden="true"
      className="relative grid size-12 place-items-center"
      data-slot="success-mark"
    >
      {reduce ? null : (
        <motion.span
          animate={{ scale: [0.6, 2.1], opacity: [0.7, 0] }}
          className="bg-foreground/10 absolute inset-0 rounded-full"
          initial={{ scale: 0.6, opacity: 0 }}
          transition={{ duration: 0.8, delay: 0.18, ease }}
        />
      )}
      <motion.span
        animate={{ scale: 1, opacity: 1 }}
        className="bg-muted absolute inset-0 rounded-full"
        initial={reduce ? false : { scale: 0.6, opacity: 0 }}
        transition={{ duration: 0.3, delay: 0.12, ease }}
      />
      <motion.span
        animate={{ scale: 1, opacity: 1 }}
        className="bg-primary text-primary-foreground relative grid size-8 place-items-center rounded-full"
        initial={reduce ? false : { scale: 0.3, opacity: 0 }}
        transition={{
          delay: 0.08,
          scale: { type: "spring", duration: 0.5, bounce: 0.5 },
          opacity: { duration: 0.12 },
        }}
      >
        <svg className="size-3.5" fill="none" viewBox="0 0 12 12">
          <motion.path
            animate={{ pathLength: 1 }}
            d="M2 6.2L4.5 8.5L10 3.5"
            initial={reduce ? false : { pathLength: 0 }}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
            transition={{ delay: 0.22, duration: 0.34, ease }}
          />
        </svg>
      </motion.span>
    </span>
  );
}

export { SuccessMark };

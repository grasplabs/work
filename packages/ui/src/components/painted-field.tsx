import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

/** The brand book's paintings: six light ones that take ink, three dark ones that take the canvas. */
type Painting =
  | "dawn"
  | "mist"
  | "sand"
  | "sage"
  | "blush"
  | "stone"
  | "grove"
  | "tide"
  | "ink";

/** The book's seven patterns of white lines over the paint. Dots is the quietest. */
type Pattern =
  | "columns"
  | "horizon"
  | "grid"
  | "rows"
  | "dots"
  | "mosaic"
  | "rings";

const paintedFieldVariants = cva("painted-field", {
  variants: {
    shape: {
      // A field that stands as a card, such as the dashboard's pile.
      card: "rounded-xl",
      // A band across the top of a page, such as Integrations'.
      band: "rounded-lg",
    },
  },
  defaultVariants: { shape: "card" },
});

/**
 * The brand's painted field (`painted-field` in styles.css): a painting, a
 * grain and a pattern, always all three, so both are asked for. It is for
 * the one or two things on a screen that matter most, and two fields side
 * by side never share a painting or a pattern. Text on it follows the
 * paint, muted text included. `render` makes it any element, such as an
 * `article` or a link. A page places it (layout classes) and nothing else:
 * its corners are its `shape`, and the room inside it is a plain element
 * of the page's own.
 */
function PaintedField({
  painting,
  pattern,
  shape = "card",
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> &
  VariantProps<typeof paintedFieldVariants> & {
    painting: Painting;
    pattern: Pattern;
  }) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn(paintedFieldVariants({ shape }), className) },
      props
    ),
    render,
    state: { slot: "painted-field", painting, pattern, shape },
  });
}

export { PaintedField, paintedFieldVariants };
export type { Painting, Pattern };

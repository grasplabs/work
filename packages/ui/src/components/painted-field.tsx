import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";

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

/**
 * The brand's painted field (`painted-field` in styles.css): a painting, a
 * grain and a pattern, always all three, so both are asked for. It is for
 * the one or two things on a screen that matter most, and two fields side
 * by side never share a painting or a pattern. Text on it follows the
 * paint, muted text included. `render` makes it any element, such as an
 * `article` or a link.
 */
function PaintedField({
  painting,
  pattern,
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & { painting: Painting; pattern: Pattern }) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("painted-field", className) },
      props
    ),
    render,
    state: { slot: "painted-field", painting, pattern },
  });
}

export { PaintedField };
export type { Painting, Pattern };

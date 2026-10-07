import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

// shadcn takes any number and passes it in an inline style. Here the ratio
// is one of a set, each a static class, so the component needs no inline
// style and Tailwind sees every class it uses.
const aspectRatioVariants = cva("relative", {
  variants: {
    ratio: {
      square: "aspect-square",
      video: "aspect-video",
      "4/3": "aspect-4/3",
      "3/2": "aspect-3/2",
      "3/4": "aspect-3/4",
      "21/9": "aspect-21/9",
    },
  },
  defaultVariants: {
    ratio: "video",
  },
});

function AspectRatio({
  ratio,
  className,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof aspectRatioVariants>) {
  return (
    <div
      data-slot="aspect-ratio"
      className={cn(aspectRatioVariants({ ratio }), className)}
      {...props}
    />
  );
}

export { AspectRatio, aspectRatioVariants };

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@grasp-os/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * `variant="pill"` is the thick slider: a track as high as its large round
 * thumb, for one setting that is the whole point of where it stands. It
 * draws no bar of its own: `field` lies under the thumb and shows how far it
 * is, as the thinking control's dots do. The track does not cut the field
 * off, so what it draws may reach past the track. The thumb glides from stop
 * to stop.
 */

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  variant = "default",
  field,
  ...props
}: SliderPrimitive.Root.Props & {
  variant?: "default" | "pill";
  field?: ReactNode;
}) {
  // One thumb per value: a range has two, a single value one. Upstream
  // counts only arrays, so a single number got two thumbs.
  const given = value ?? defaultValue;
  let _values: readonly number[] = [min, max];
  if (typeof given === "number") {
    _values = [given];
  } else if (given !== undefined) {
    _values = given;
  }
  const pill = variant === "pill";

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={
            pill
              ? "bg-muted relative h-11 w-full grow rounded-full select-none"
              : "bg-muted relative grow overflow-hidden rounded-full select-none data-horizontal:h-1.5 data-horizontal:w-full data-vertical:h-full data-vertical:w-1.5"
          }
        >
          {pill ? field : null}
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={
              pill
                ? "h-full select-none"
                : "bg-primary select-none data-horizontal:h-full data-vertical:w-full"
            }
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            className={
              pill
                ? "bg-tile ring-foreground/10 hover:ring-foreground/25 focus-visible:ring-ring block size-9 shrink-0 cursor-grab rounded-full shadow-md ring-1 transition-[inset-inline-start,box-shadow,scale] duration-300 ease-out select-none focus-visible:ring-2 focus-visible:outline-hidden active:scale-95 active:cursor-grabbing"
                : "border-primary ring-ring/50 bg-tile block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
            }
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };

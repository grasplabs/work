"use client";

import { useDirection } from "@base-ui/react/direction-provider";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import useEmblaCarousel from "embla-carousel-react";
import type { UseEmblaCarouselType } from "embla-carousel-react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

type CarouselApi = UseEmblaCarouselType[1];

/** Whether a key press belongs to a field the person is typing in. */
const isEditable = (target: EventTarget): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/**
 * The keys for the previous and next slide: up and down when vertical, and
 * left and right the other way round in right-to-left text.
 */
const slideKeys = (
  orientation: "horizontal" | "vertical",
  direction: "ltr" | "rtl"
): { previous: string; next: string } => {
  if (orientation === "vertical") {
    return { previous: "ArrowUp", next: "ArrowDown" };
  }
  if (direction === "rtl") {
    return { previous: "ArrowRight", next: "ArrowLeft" };
  }
  return { previous: "ArrowLeft", next: "ArrowRight" };
};
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];

interface CarouselProps {
  opts?: CarouselOptions;
  plugins?: CarouselPlugin;
  orientation?: "horizontal" | "vertical";
  setApi?: (api: CarouselApi) => void;
}

type CarouselContextProps = {
  carouselRef: ReturnType<typeof useEmblaCarousel>[0];
  api: ReturnType<typeof useEmblaCarousel>[1];
  scrollPrev: () => void;
  scrollNext: () => void;
  canScrollPrev: boolean;
  canScrollNext: boolean;
} & CarouselProps;

const CarouselContext = React.createContext<CarouselContextProps | null>(null);

function useCarousel() {
  const context = React.useContext(CarouselContext);

  if (!context) {
    throw new Error("useCarousel must be used within a <Carousel />");
  }

  return context;
}

function Carousel({
  orientation = "horizontal",
  opts,
  setApi,
  plugins,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & CarouselProps) {
  // Right-to-left text scrolls the slides the other way (embla's `direction`).
  const direction = useDirection();
  const [carouselRef, api] = useEmblaCarousel(
    {
      direction,
      ...opts,
      axis: orientation === "horizontal" ? "x" : "y",
    },
    plugins
  );
  // Whether it can scroll either way, read from the carousel as it changes
  // (upstream copies them into state from an effect).
  const subscribe = (onChange: () => void) => {
    api?.on("reInit", onChange).on("select", onChange);
    return () => {
      api?.off("reInit", onChange).off("select", onChange);
    };
  };
  const canScrollPrev = React.useSyncExternalStore(
    subscribe,
    () => api?.canScrollPrev() ?? false,
    () => false
  );
  const canScrollNext = React.useSyncExternalStore(
    subscribe,
    () => api?.canScrollNext() ?? false,
    () => false
  );

  const scrollPrev = () => {
    api?.scrollPrev();
  };

  const scrollNext = () => {
    api?.scrollNext();
  };

  // Upstream takes the left and right arrows from everything inside,
  // fields too, and only those two, whatever the orientation.
  const keys = slideKeys(orientation, opts?.direction ?? direction);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditable(event.target)) {
      return;
    }
    if (event.key === keys.previous) {
      event.preventDefault();
      scrollPrev();
    } else if (event.key === keys.next) {
      event.preventDefault();
      scrollNext();
    }
  };

  React.useEffect(() => {
    if (api !== undefined) {
      setApi?.(api);
    }
  }, [api, setApi]);

  const contextValue = {
    carouselRef,
    api,
    opts,
    orientation,
    scrollPrev,
    scrollNext,
    canScrollPrev,
    canScrollNext,
  };

  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <CarouselContext.Provider value={contextValue}>
      <div
        onKeyDownCapture={handleKeyDown}
        className={cn("relative", className)}
        role="region"
        aria-roledescription="carousel"
        data-slot="carousel"
        {...props}
      >
        {children}
      </div>
    </CarouselContext.Provider>
  );
}

function CarouselContent({ className, ...props }: React.ComponentProps<"div">) {
  const { carouselRef, orientation } = useCarousel();

  return (
    <div
      ref={carouselRef}
      className="overflow-hidden"
      data-slot="carousel-content"
    >
      <div
        className={cn(
          "flex",
          orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col",
          className
        )}
        {...props}
      />
    </div>
  );
}

function CarouselItem({ className, ...props }: React.ComponentProps<"div">) {
  const { orientation } = useCarousel();

  return (
    <div
      role="group"
      aria-roledescription="slide"
      data-slot="carousel-item"
      className={cn(
        "min-w-0 shrink-0 grow-0 basis-full",
        orientation === "horizontal" ? "pl-4" : "pt-4",
        className
      )}
      {...props}
    />
  );
}

function CarouselPrevious({
  className,
  variant = "outline",
  size = "icon-sm",
  label = "Previous slide",
  ...props
}: React.ComponentProps<typeof Button> & {
  /** The button's name, read out by screen readers. */
  label?: string;
}) {
  const { orientation, scrollPrev, canScrollPrev } = useCarousel();

  return (
    <Button
      data-slot="carousel-previous"
      variant={variant}
      size={size}
      className={cn(
        "absolute touch-manipulation rounded-full",
        orientation === "horizontal"
          ? "inset-y-0 -left-12 my-auto"
          : "-top-12 left-1/2 -translate-x-1/2 rotate-90",
        className
      )}
      disabled={!canScrollPrev}
      onClick={scrollPrev}
      {...props}
    >
      <ChevronLeftIcon
        className={cn(orientation === "horizontal" && "rtl:rotate-180")}
      />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

function CarouselNext({
  className,
  variant = "outline",
  size = "icon-sm",
  label = "Next slide",
  ...props
}: React.ComponentProps<typeof Button> & {
  /** The button's name, read out by screen readers. */
  label?: string;
}) {
  const { orientation, scrollNext, canScrollNext } = useCarousel();

  return (
    <Button
      data-slot="carousel-next"
      variant={variant}
      size={size}
      className={cn(
        "absolute touch-manipulation rounded-full",
        orientation === "horizontal"
          ? "inset-y-0 -right-12 my-auto"
          : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
        className
      )}
      disabled={!canScrollNext}
      onClick={scrollNext}
      {...props}
    >
      <ChevronRightIcon
        className={cn(orientation === "horizontal" && "rtl:rotate-180")}
      />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  useCarousel,
};

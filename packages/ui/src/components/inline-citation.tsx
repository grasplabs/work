// A citation in running text: the cited words, a badge naming the source,
// and on hover a card that pages through the sources with their quotes.
// Ported from the prototype's AI Elements inline citation
// (grasplabs/prototype `components/ai-elements/inline-citation.tsx`,
// ddd235d), with the same markup and classes. Where the kit differs:
// - its words are English props with defaults (`label`, `unknown`), as the
//   kit's other components have them, since App screens carry no Lingui;
// - the index reads the carousel as it changes, not through an effect;
// - no hand-written memo: the React Compiler memoises it.
import { Badge } from "@grasp-os/ui/components/badge";
import type { CarouselApi } from "@grasp-os/ui/components/carousel";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@grasp-os/ui/components/carousel";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@grasp-os/ui/components/hover-card";
import { cn } from "@grasp-os/ui/lib/utils";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";

function InlineCitation({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="inline-citation"
      className={cn("group inline items-center gap-1", className)}
      {...props}
    />
  );
}

function InlineCitationText({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="inline-citation-text"
      className={cn("group-hover:bg-accent transition-colors", className)}
      {...props}
    />
  );
}

function InlineCitationCard(props: React.ComponentProps<typeof HoverCard>) {
  return <HoverCard {...props} />;
}

/** A source is a URL or, for a document without one, its title. */
const sourceLabel = (source: string): string => {
  try {
    return new URL(source).hostname;
  } catch {
    return source;
  }
};

function InlineCitationCardTrigger({
  sources,
  unknown = "unknown",
  className,
  ...props
}: React.ComponentProps<typeof Badge> & {
  /** The sources cited, URLs or titles; the badge names the first. */
  sources: readonly string[];
  /** What the badge says when no source is known. */
  unknown?: string;
}) {
  const [first] = sources;
  return (
    <HoverCardTrigger
      closeDelay={0}
      delay={0}
      render={
        <Badge
          data-slot="inline-citation-trigger"
          className={cn("ml-1 rounded-full", className)}
          variant="secondary"
          {...props}
        />
      }
    >
      {first === undefined ? (
        unknown
      ) : (
        <>
          {sourceLabel(first)} {sources.length > 1 && `+${sources.length - 1}`}
        </>
      )}
    </HoverCardTrigger>
  );
}

function InlineCitationCardBody({
  className,
  ...props
}: React.ComponentProps<typeof HoverCardContent>) {
  return (
    <HoverCardContent
      data-slot="inline-citation-card"
      className={cn("relative w-80 p-0", className)}
      {...props}
    />
  );
}

const CarouselApiContext = createContext<CarouselApi | undefined>(undefined);

function InlineCitationCarousel({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Carousel>) {
  const [api, setApi] = useState<CarouselApi>();
  return (
    <CarouselApiContext.Provider value={api}>
      <Carousel className={cn("w-full", className)} setApi={setApi} {...props}>
        {children}
      </Carousel>
    </CarouselApiContext.Provider>
  );
}

function InlineCitationCarouselContent(props: React.ComponentProps<"div">) {
  return <CarouselContent {...props} />;
}

function InlineCitationCarouselItem({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <CarouselItem
      className={cn("w-full space-y-2 p-4 pl-8", className)}
      {...props}
    />
  );
}

function InlineCitationCarouselHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-citation-header"
      className={cn(
        "bg-secondary flex items-center justify-between gap-2 rounded-t-md p-2",
        className
      )}
      {...props}
    />
  );
}

/** Which source of how many is showing, following the carousel. */
function InlineCitationCarouselIndex({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  const api = useContext(CarouselApiContext);
  // Read from the carousel as it changes (upstream copies them into state
  // from an effect), as the kit's carousel reads whether it can scroll.
  const subscribe = (onChange: () => void) => {
    api?.on("reInit", onChange).on("select", onChange);
    return () => {
      api?.off("reInit", onChange).off("select", onChange);
    };
  };
  const count = useSyncExternalStore(
    subscribe,
    () => api?.scrollSnapList().length ?? 0,
    () => 0
  );
  const current = useSyncExternalStore(
    subscribe,
    () => (api === undefined ? 0 : api.selectedScrollSnap() + 1),
    () => 0
  );

  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-1 items-center justify-end px-3 py-1 text-xs",
        className
      )}
      {...props}
    >
      {children ?? `${current}/${count}`}
    </div>
  );
}

function InlineCitationCarouselPrev({
  className,
  label = "Previous",
  ...props
}: React.ComponentProps<"button"> & { label?: string }) {
  const api = useContext(CarouselApiContext);
  return (
    <button
      aria-label={label}
      className={cn("shrink-0", className)}
      onClick={() => api?.scrollPrev()}
      type="button"
      {...props}
    >
      <ArrowLeftIcon className="text-muted-foreground size-4" />
    </button>
  );
}

function InlineCitationCarouselNext({
  className,
  label = "Next",
  ...props
}: React.ComponentProps<"button"> & { label?: string }) {
  const api = useContext(CarouselApiContext);
  return (
    <button
      aria-label={label}
      className={cn("shrink-0", className)}
      onClick={() => api?.scrollNext()}
      type="button"
      {...props}
    >
      <ArrowRightIcon className="text-muted-foreground size-4" />
    </button>
  );
}

function InlineCitationSource({
  title,
  url,
  description,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  title?: string;
  url?: string;
  description?: string;
}) {
  return (
    <div className={cn("space-y-1", className)} {...props}>
      {title !== undefined && (
        <h4 className="truncate text-sm leading-tight font-medium">{title}</h4>
      )}
      {url !== undefined && (
        <p className="text-muted-foreground truncate text-xs break-all">
          {url}
        </p>
      )}
      {description !== undefined && (
        <p className="text-muted-foreground line-clamp-3 text-sm leading-relaxed">
          {description}
        </p>
      )}
      {children}
    </div>
  );
}

function InlineCitationQuote({
  children,
  className,
  ...props
}: React.ComponentProps<"blockquote">) {
  return (
    <blockquote
      className={cn(
        "border-muted text-muted-foreground border-l-2 pl-3 text-sm italic",
        className
      )}
      {...props}
    >
      {children}
    </blockquote>
  );
}

export {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationQuote,
  InlineCitationSource,
  InlineCitationText,
};

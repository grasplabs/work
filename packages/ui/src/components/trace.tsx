// The steps something took, one quiet line each, as shadcn's chatbot
// template draws an answer's steps (grasplabs/prototype
// `components/ui/trace.tsx`): how long it worked, its thinking, each tool it
// ran. A step turns while it runs, and one with more to show folds open.
// The kit has no words of its own: the page passes every label, already in
// the reader's language.
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { cn } from "@grasp-os/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";

/** The trace: its steps, one under the other. */
function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn(
        "*:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/30 flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-lg *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-3",
        className
      )}
      {...props}
    />
  );
}

/**
 * One step on its own line. `running` turns while it is at work; `error`
 * failed; `pending` waits its turn; `attention` waits on someone. `wrap`
 * lets a step that is a sentence run onto more lines instead of being cut
 * short.
 */
function TraceLine({
  className,
  status,
  wrap = false,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending" | "attention";
  wrap?: boolean;
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      data-wrap={wrap || undefined}
      className={cn(
        "text-muted-foreground data-[status=error]:text-destructive data-[status=attention]:text-status-attention in-[a:hover,button:hover]:text-foreground data-[status=error]:in-[a:hover,button:hover]:text-destructive flex w-fit max-w-full min-w-0 items-center gap-2 text-sm transition-colors in-[a,button]:cursor-pointer data-wrap:items-start data-wrap:*:data-[slot=trace-icon]:h-5 data-wrap:*:data-[slot=trace-title]:whitespace-normal data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:animate-pulse",
        className
      )}
      {...props}
    />
  );
}

/** A step's icon, at the start of its line. */
function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ms-1",
        className
      )}
      {...props}
    />
  );
}

/** What a step is, cut short to its line unless the line wraps. */
function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-title"
      className={cn("min-w-0 truncate motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/** A step's quiet detail after its title, such as how long it took. */
function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn(
        "text-muted-foreground/70 shrink-0 tabular-nums",
        className
      )}
      {...props}
    />
  );
}

/** A step with more to show, folded until it is opened. */
function TraceCollapsible({
  className,
  ...props
}: React.ComponentProps<typeof Collapsible>) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn("flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  );
}

/** The step's line, which folds what it shows open or closed. */
function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-trigger text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 has-[[data-status=error]]:text-destructive flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-lg text-left transition-colors outline-none focus-visible:ring-3",
        className
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform group-aria-expanded/trace-trigger:rotate-90 motion-reduce:transition-none">
        <ChevronRightIcon />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

/** What a step shows once opened, along a thin line under its icon. */
function TraceCollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className="h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] duration-200 data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          "text-muted-foreground ms-1.75 mt-2 mb-1 min-w-0 border-s ps-4 pe-1 leading-relaxed wrap-break-word",
          className
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
};

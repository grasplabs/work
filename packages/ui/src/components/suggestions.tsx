// Not in shadcn: the questions to start a conversation from, under an
// empty chat's box (grasplabs/prototype `components/chat/suggestions.tsx`).
// A list, named by `aria-label`, of buttons that each ask their question
// with one click. `quiet`: rows of muted text, so the box stays what the
// page is about. `card`: rows on a card, each with a chevron, where the
// questions are the page's way in.
"use client";

import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { ChevronRightIcon } from "lucide-react";
import { createContext, use } from "react";

const suggestionsVariants = cva("flex flex-col", {
  variants: {
    variant: {
      quiet: "",
      card: "bg-card overflow-hidden rounded-xl border",
    },
  },
  defaultVariants: { variant: "quiet" },
});

const suggestionVariants = cva(
  "focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-3 text-left text-sm outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        quiet:
          "text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg px-4.5 py-2 transition-colors duration-150",
        card: "hover:bg-muted/60 focus-visible:bg-muted/60 px-3.5 py-2.5 focus-visible:ring-inset",
      },
    },
    defaultVariants: { variant: "quiet" },
  }
);

type SuggestionsVariant = NonNullable<
  VariantProps<typeof suggestionsVariants>["variant"]
>;

const SuggestionsContext = createContext<SuggestionsVariant>("quiet");

function Suggestions({
  className,
  variant = "quiet",
  ...props
}: React.ComponentProps<"ul"> & VariantProps<typeof suggestionsVariants>) {
  const shown = variant ?? "quiet";
  return (
    <SuggestionsContext value={shown}>
      <ul
        data-slot="suggestions"
        data-variant={shown}
        className={cn(suggestionsVariants({ variant: shown }), className)}
        {...props}
      />
    </SuggestionsContext>
  );
}

/** One question: a button in its own list item, which asks it when pressed. */
function Suggestion({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"button">, "type">) {
  const variant = use(SuggestionsContext);
  return (
    <li
      data-slot="suggestion"
      className={cn("flex", variant === "card" && "border-b last:border-b-0")}
    >
      <button
        className={cn(suggestionVariants({ variant }), className)}
        type="button"
        {...props}
      >
        {variant === "card" ? (
          <>
            <span className="min-w-0 flex-1 text-pretty">{children}</span>
            <ChevronRightIcon
              aria-hidden="true"
              className="text-muted-foreground size-4 flex-none"
            />
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate">{children}</span>
        )}
      </button>
    </li>
  );
}

export { Suggestion, Suggestions, suggestionsVariants };

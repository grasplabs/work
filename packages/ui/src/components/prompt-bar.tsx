"use client";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { useOpenChangeComplete } from "@grasp-os/ui/hooks/use-open-change-complete";
import { cn } from "@grasp-os/ui/lib/utils";
import * as React from "react";

// One line to ask in, floating over the page: round and lifted, it rises
// into place as it opens and sinks back out as it closes, staying mounted so
// what is typed in it stays; `onOpenChangeComplete` says when it has, for
// what moves next. A mark on its
// left, the line, and an action on its right. Its parts keep InputGroup's
// own slots, which its focus and layout styles read.
//
//   <PromptBar>
//     <PromptBarIcon><GraspMark /></PromptBarIcon>
//     <PromptBarInput aria-label="Ask" placeholder="Ask" />
//     <PromptBarActions>
//       <PromptBarAction aria-label="Open"><PanelRightOpenIcon /></PromptBarAction>
//     </PromptBarActions>
//   </PromptBar>

function PromptBar({
  open = true,
  delayed = false,
  onOpenChangeComplete,
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroup>, "size"> & {
  /** Shown: it rises in as it opens and sinks back out as it closes. */
  open?: boolean;
  /** Rises or sinks a beat after what moves with it (the theme's `--motion-stagger`). */
  delayed?: boolean;
  /** Once it has finished rising in or sinking out. */
  onOpenChangeComplete?: (open: boolean) => void;
}) {
  const bar = React.useRef<HTMLDivElement>(null);
  useOpenChangeComplete(bar, open, onOpenChangeComplete);
  return (
    <div
      ref={bar}
      data-delayed={delayed}
      data-slot="prompt-bar-frame"
      data-state={open ? "open" : "closed"}
      inert={!open}
      className="ease-sidebar max-w-full transition-[opacity,translate] duration-(--motion-duration) data-[delayed=true]:delay-(--motion-stagger) data-[state=closed]:invisible data-[state=closed]:translate-y-2 data-[state=closed]:opacity-0 data-[state=closed]:transition-[opacity,translate,visibility] motion-reduce:transition-none"
    >
      <InputGroup
        data-slot="prompt-bar"
        className={cn(
          "shadow-lifted has-[[data-slot=input-group-control]:focus-visible]:ring-ring/25 border-border h-13 w-96 max-w-full rounded-full px-2 transition-[color,box-shadow] duration-200 has-[[data-slot=input-group-control]:focus-visible]:ring-1 motion-reduce:transition-none",
          className
        )}
        {...props}
      />
    </div>
  );
}

/** The bar's mark, on its left; `working` makes it breathe. */
function PromptBarIcon({
  working = false,
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupAddon>, "align"> & {
  working?: boolean;
}) {
  return (
    <InputGroupAddon
      data-working={working}
      align="inline-start"
      aria-hidden
      className={cn(
        "text-foreground pe-1.5 data-[working=true]:animate-pulse [&>svg]:size-5",
        className
      )}
      {...props}
    />
  );
}

function PromptBarInput({
  className,
  ...props
}: React.ComponentProps<typeof InputGroupInput>) {
  return <InputGroupInput className={cn("px-1", className)} {...props} />;
}

/** The bar's actions, on its right, as far from its edge as its mark is from the other. */
function PromptBarActions({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupAddon>, "align">) {
  return (
    <InputGroupAddon
      align="inline-end"
      className={cn("pe-1", className)}
      {...props}
    />
  );
}

/** One of its actions: round, filled (`variant="default"`) when it is the one to press. */
function PromptBarAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupButton>, "size">) {
  return (
    <InputGroupButton
      data-slot="prompt-bar-action"
      size="icon-sm"
      className={cn("rounded-full", className)}
      {...props}
    />
  );
}

export {
  PromptBar,
  PromptBarAction,
  PromptBarActions,
  PromptBarIcon,
  PromptBarInput,
};

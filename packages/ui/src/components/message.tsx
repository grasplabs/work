import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse",
        className
      )}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        "bg-muted flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full group-has-data-[slot=message-footer]/message:-translate-y-8",
        className
      )}
      {...props}
    />
  );
}

/**
 * `reading` sets an answer as the prototype sets Grasp's answers in the
 * chat (shadcn/typeset's reading text): 15px with room between the lines,
 * an eighth larger on a phone, where it is read from further off. A
 * step's own line (`TraceLine`) keeps its size.
 */
const messageContentVariants = cva(
  "flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end",
  {
    variants: {
      size: {
        default: "",
        reading: "text-[1.0546875rem]/[1.7] md:text-[0.9375rem]",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

function MessageContent({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof messageContentVariants>) {
  return (
    <div
      data-slot="message-content"
      data-size={size}
      className={cn(messageContentVariants({ size }), className)}
      {...props}
    />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "text-muted-foreground flex max-w-full min-w-0 items-center px-3 text-xs font-medium group-has-data-[variant=ghost]/message:px-0",
        className
      )}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "text-muted-foreground flex max-w-full min-w-0 items-center px-3 text-xs font-medium group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end",
        className
      )}
      {...props}
    />
  );
}

/** A quiet row of actions under a message's content. */
function MessageActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-actions"
      className={cn("-ml-1.5 flex items-center gap-1", className)}
      {...props}
    />
  );
}

/**
 * One small action in that row: an icon, named by `label` (already in the
 * reader's language) for a screen reader and in its tooltip.
 */
function MessageAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export {
  MessageAction,
  MessageActions,
  MessageGroup,
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
};

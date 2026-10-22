import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import type { ReactNode } from "react";

import { PlainMarkdown } from "../knowledge/markdown.tsx";

// One message of a chat, in the prototype's AI Elements message
// (grasplabs/prototype `components/ai-elements/message.tsx`, ddd235d):
// the person's question in a grey bubble on the right, Grasp's answer
// across the thread, a quiet row of actions under it. Where it differs:
// - who wrote it is Grasp's own (`user` or `assistant`), not another
//   SDK's message type;
// - the answer is rendered as the thread renders Markdown already
//   (`PlainMarkdown`: GitHub-flavoured, no raw HTML), not by Streamdown;
// - the prototype's branches and toolbar aren't here: no chat surface
//   uses them.

/** A message, the person's or Grasp's. */
export const Message = ({
  from,
  className,
  ...props
}: React.ComponentProps<"div"> & { from: "user" | "assistant" }) => (
  <div
    className={cn(
      "group flex w-full min-w-0 flex-col gap-2",
      from === "user" && "ml-auto max-w-11/12 items-end",
      className
    )}
    data-from={from}
    {...props}
  />
);

/** What a message says: the person's in a grey bubble, Grasp's plain. */
export const MessageContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex w-full min-w-0 flex-col gap-3 text-sm",
      "group-data-[from=user]:bg-secondary group-data-[from=user]:text-foreground group-data-[from=user]:w-fit group-data-[from=user]:rounded-lg group-data-[from=user]:px-4 group-data-[from=user]:py-3 group-data-[from=user]:whitespace-pre-wrap",
      className
    )}
    {...props}
  />
);

/** The quiet row of actions under an answer. */
export const MessageActions = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("-ml-1.5 flex items-center gap-1", className)}
    {...props}
  />
);

/** A small button under an answer, named by its tooltip. */
export const MessageAction = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) => (
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

/**
 * An answer's words, as Markdown, its links to the notes it cites
 * (`cited`, a stored answer's citations) opening them; one still being
 * written cites none.
 */
export const MessageResponse = ({
  text,
  cited,
}: {
  text: string;
  cited?: readonly string[];
}) => <PlainMarkdown cited={cited} text={text} />;

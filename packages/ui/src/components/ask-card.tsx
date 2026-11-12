import { CheckboxGroup as CheckboxGroupPrimitive } from "@base-ui/react/checkbox-group";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Kbd } from "@grasp-os/ui/components/kbd";
import { cn } from "@grasp-os/ui/lib/utils";
import * as React from "react";

// What an assistant asks the person, in place of the box to ask in: a
// card with a short topic and where they are ("1 of 3") on top, the
// question, the options to pick (each a row: its radio or checkbox, a
// label, a line saying what it means, a mark for the one the assistant
// recommends, and the number key that picks it), as a radio group or, where
// several may be picked, a checkbox group, and the actions under them.
// Not in shadcn; built as its parts are. It shows; the page asks: the
// values, the keys, the words, all the page's.
//
//   <AskCard aria-label="Grasp asks">
//     <AskCardHeader>
//       <AskCardTopic>Direction</AskCardTopic>
//       <AskCardProgress current={1} total={2}>1 of 2</AskCardProgress>
//     </AskCardHeader>
//     <AskCardBody>
//       <AskCardQuestion id={id}>Which direction?</AskCardQuestion>
//       <AskCardChoices aria-labelledby={id} …>
//         <AskCardOption control={<RadioGroupItem value="0" />} shortcut="1"
//           description="Compact KPIs and clear trends">Executive</AskCardOption>
//       </AskCardChoices>
//     </AskCardBody>
//     <AskCardFooter>…</AskCardFooter>
//   </AskCard>

/** The card: bounded, so long options scroll and the actions stay in reach. */
function AskCard({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="ask-card"
      className={cn(
        "bg-card text-card-foreground flex max-h-[min(32rem,70vh)] min-h-0 flex-col rounded-xl border text-sm shadow-xs",
        className
      )}
      {...props}
    />
  );
}

/** Its top row: what it is about, and how far along. */
function AskCardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="ask-card-header"
      className={cn(
        "text-muted-foreground flex min-w-0 items-center gap-2 px-4 pt-3.5 text-xs",
        className
      )}
      {...props}
    />
  );
}

/** A few words naming what is asked about. */
function AskCardTopic({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="ask-card-topic"
      className={cn(
        "bg-muted text-foreground truncate rounded-md px-1.5 py-0.5 font-medium",
        className
      )}
      {...props}
    />
  );
}

/**
 * Where the person is: the question they are on (`current`, from 1) of
 * `total`, as a dot each, and in words (`children`), which assistive
 * technology reads; nothing for a single question.
 */
function AskCardProgress({
  className,
  current,
  total,
  children,
  ...props
}: React.ComponentProps<"span"> & { current: number; total: number }) {
  if (total < 2) {
    return null;
  }
  return (
    <span
      data-slot="ask-card-progress"
      className={cn("ms-auto flex items-center gap-2 tabular-nums", className)}
      {...props}
    >
      <span aria-hidden="true" className="flex items-center gap-1">
        {Array.from({ length: total }, (_, index) => (
          <span
            className={cn(
              "ease-sidebar size-1.5 rounded-full transition-colors duration-(--motion-duration)",
              index < current ? "bg-foreground" : "bg-border"
            )}
            // The dots stand for steps, which have no IDs of their own.
            key={index}
          />
        ))}
      </span>
      {children}
    </span>
  );
}

/** The question and its options, which scroll when they don't fit. */
function AskCardBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="ask-card-body"
      className={cn(
        "flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pt-2 pb-3",
        className
      )}
      {...props}
    />
  );
}

/** The question itself, which names its options' group (`id`). */
function AskCardQuestion({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="ask-card-question"
      className={cn("text-[0.9375rem] font-medium text-pretty", className)}
      {...props}
    />
  );
}

/**
 * The options where one is picked: a radio group (the kit's
 * `RadioGroupItem` in each option's `control`), named by its question.
 */
function AskCardChoices({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="ask-card-choices"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

/**
 * The options where several may be picked: a checkbox group (the kit's
 * `Checkbox`, with its `value`, in each option's `control`).
 */
function AskCardChecks({ className, ...props }: CheckboxGroupPrimitive.Props) {
  return (
    <CheckboxGroupPrimitive
      data-slot="ask-card-checks"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

/**
 * One option: its `control` (a radio, or a checkbox where several may be
 * picked), its label (`children`), what it means (`description`), a mark
 * beside the label (`badge`, as for the recommended one), and the key
 * that picks it (`shortcut`). The whole row picks it.
 */
function AskCardOption({
  className,
  control,
  description,
  badge,
  shortcut,
  children,
  ...props
}: React.ComponentProps<"label"> & {
  control: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  shortcut?: string;
}) {
  return (
    // The control inside is what is labelled: the row is its label.
    <label
      data-slot="ask-card-option"
      className={cn(
        "hover:bg-muted/60 has-data-checked:bg-muted has-focus-visible:ring-ring/50 relative -mx-2 flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors duration-100 has-focus-visible:ring-3 has-disabled:cursor-not-allowed has-disabled:opacity-50 [&>[data-slot=checkbox]]:mt-0.5 [&>[data-slot=radio-group-item]]:mt-0.5",
        className
      )}
      {...props}
    >
      {control}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 leading-snug font-medium">
          {children}
          {badge}
        </span>
        {description === undefined ? null : (
          <span className="text-muted-foreground text-xs leading-snug">
            {description}
          </span>
        )}
      </span>
      {shortcut === undefined ? null : (
        <Kbd aria-hidden="true" className="mt-px">
          {shortcut}
        </Kbd>
      )}
    </label>
  );
}

/** Its actions, under a line: such as typing instead, back, next and send. */
function AskCardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="ask-card-footer"
      className={cn(
        "flex flex-wrap items-center gap-2 border-t px-3 py-2.5",
        className
      )}
      {...props}
    />
  );
}

export {
  AskCard,
  AskCardBody,
  AskCardChecks,
  AskCardChoices,
  AskCardFooter,
  AskCardHeader,
  AskCardOption,
  AskCardProgress,
  AskCardQuestion,
  AskCardTopic,
};

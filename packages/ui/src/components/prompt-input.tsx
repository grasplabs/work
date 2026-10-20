// The parts of a message composer: a growing textarea that sends on Enter,
// a header and a footer row, the footer's tools, icon buttons with a
// tooltip, an actions menu and the send button. Ported from the
// prototype's AI Elements prompt input
// (grasplabs/prototype `components/ai-elements/prompt-input.tsx`, ddd235d),
// with the same markup and classes, laid out on the kit's input group.
//
// Only the generic parts are in the kit. The composer's form, its
// attachments and screen capture know Grasp's chat, so they live with it
// in the frontend (GRA-775), which hands the textarea its attachments
// through `PromptInputAttachmentsContext`. Where the kit differs:
// - its words are English props with defaults, as the kit's other
//   components have them, since App screens carry no Lingui;
// - the send button's states are the kit's own (`PromptInputStatus`),
//   not another SDK's chat status;
// - no hand-written memo: the React Compiler memoises it.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@grasp-os/ui/components/input-group";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import { ArrowUpIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { createContext, isValidElement, useContext, useState } from "react";

/**
 * The files attached to the message being written, as the composer that
 * holds them gives them to the textarea: pasting files adds them, and
 * Backspace in an empty textarea takes the last one off.
 */
interface PromptInputAttachments {
  readonly files: readonly { readonly id: string }[];
  add: (files: readonly File[]) => void;
  remove: (id: string) => void;
}

/** The attachments of the composer around a textarea, when it has any. */
const PromptInputAttachmentsContext = createContext<
  PromptInputAttachments | undefined
>(undefined);

function PromptInputBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="prompt-input-body"
      className={cn("contents", className)}
      {...props}
    />
  );
}

/** The files a paste carries, if any. */
const pastedFiles = (event: React.ClipboardEvent): File[] =>
  [...(event.clipboardData?.items ?? [])].flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file === null ? [] : [file];
  });

/** The key code of a key an input method is handling (`keyCode` 229). */
const imeKeyCode = 229;

/**
 * Sends `form` as its send button would: not while the button is off, nor
 * while an answer is coming and it stops that answer instead; the button
 * as the submitter, as a click on it would be.
 */
const send = (form: HTMLFormElement | null): void => {
  const submit =
    form?.querySelector<HTMLButtonElement>(
      '[data-slot="prompt-input-submit"]'
    ) ?? form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit?.disabled === true || submit?.type === "button") {
    return;
  }
  form?.requestSubmit(submit ?? undefined);
};

function PromptInputTextarea({
  onKeyDown,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  className,
  placeholder = "What would you like to know?",
  ...props
}: React.ComponentProps<typeof InputGroupTextarea>) {
  const attachments = useContext(PromptInputAttachmentsContext);
  // An input method composing a character uses Enter to pick it.
  const [composing, setComposing] = useState(false);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !composing &&
      !event.nativeEvent.isComposing &&
      // Safari ends the composition before the Enter that confirms it, and
      // marks that Enter with the input method's key code.
      // oxlint-disable-next-line typescript/no-deprecated -- the one signal Safari gives
      event.nativeEvent.keyCode !== imeKeyCode
    ) {
      event.preventDefault();
      send(event.currentTarget.form);
      return;
    }
    const last = attachments?.files.at(-1);
    if (
      event.key === "Backspace" &&
      event.currentTarget.value === "" &&
      last !== undefined
    ) {
      event.preventDefault();
      attachments?.remove(last.id);
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented || attachments === undefined) {
      return;
    }
    const files = pastedFiles(event);
    if (files.length === 0) {
      return;
    }
    // Text pasted with the files is still typed in; a paste of files alone
    // types nothing.
    if (event.clipboardData.getData("text/plain") === "") {
      event.preventDefault();
    }
    attachments.add(files);
  };

  return (
    <InputGroupTextarea
      // The text stands as far from the box's edge as the icons in the row under it.
      className={cn(
        "field-sizing-content max-h-48 min-h-16 px-4.5 pt-3.5",
        className
      )}
      name="message"
      onCompositionEnd={(event) => {
        setComposing(false);
        onCompositionEnd?.(event);
      }}
      onCompositionStart={(event) => {
        setComposing(true);
        onCompositionStart?.(event);
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
    />
  );
}

function PromptInputHeader({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupAddon>, "align">) {
  return (
    <InputGroupAddon
      align="block-end"
      className={cn("order-first flex-wrap gap-1", className)}
      {...props}
    />
  );
}

function PromptInputFooter({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupAddon>, "align">) {
  return (
    <InputGroupAddon
      align="block-end"
      className={cn("justify-between gap-1", className)}
      {...props}
    />
  );
}

function PromptInputTools({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="prompt-input-tools"
      className={cn("flex min-w-0 items-center gap-1", className)}
      {...props}
    />
  );
}

/** A button's tooltip: its words, or its words with a shortcut and a side. */
type PromptInputButtonTooltip =
  | string
  | {
      content: React.ReactNode;
      shortcut?: string;
      side?: React.ComponentProps<typeof TooltipContent>["side"];
    };

type PromptInputButtonProps = React.ComponentProps<typeof InputGroupButton> & {
  tooltip?: PromptInputButtonTooltip;
};

function PromptInputButton({
  variant = "ghost",
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) {
  // A lone icon is a square button; words, with or without an icon, a wide one.
  const icon = isValidElement(props.children);
  const button = (
    <InputGroupButton
      // A lone icon is named by its tooltip's words, unless named already.
      aria-label={icon && typeof tooltip === "string" ? tooltip : undefined}
      size={size ?? (icon ? "icon-sm" : "sm")}
      type="button"
      variant={variant}
      {...props}
    />
  );
  if (tooltip === undefined) {
    return button;
  }
  const { content, shortcut, side } =
    typeof tooltip === "string"
      ? { content: tooltip, shortcut: undefined, side: undefined }
      : tooltip;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side={side ?? "top"}>
        {content}
        {shortcut !== undefined && (
          <span className="text-muted-foreground ml-2">{shortcut}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function PromptInputActionMenu(
  props: React.ComponentProps<typeof DropdownMenu>
) {
  return <DropdownMenu {...props} />;
}

function PromptInputActionMenuTrigger({
  children,
  "aria-label": ariaLabel,
  ...props
}: PromptInputButtonProps) {
  // The default trigger is a lone icon: it gets a name unless given one.
  const label =
    ariaLabel ?? (children === undefined ? "More actions" : undefined);
  return (
    <DropdownMenuTrigger
      render={
        <PromptInputButton
          // Only a name it has: an undefined one would hide its tooltip's.
          {...(label === undefined ? {} : { "aria-label": label })}
          {...props}
        />
      }
    >
      {children ?? <PlusIcon className="size-4" />}
    </DropdownMenuTrigger>
  );
}

function PromptInputActionMenuContent(
  props: React.ComponentProps<typeof DropdownMenuContent>
) {
  return <DropdownMenuContent align="start" {...props} />;
}

function PromptInputActionMenuItem(
  props: React.ComponentProps<typeof DropdownMenuItem>
) {
  return <DropdownMenuItem {...props} />;
}

/**
 * Where the message being sent is: ready to send, sent and waiting for an
 * answer, being answered, or failed.
 */
type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

/** The send button's icon for each status. */
const statusIcons: Record<PromptInputStatus, React.ReactNode> = {
  ready: <ArrowUpIcon className="size-4" />,
  submitted: <Spinner />,
  streaming: <SquareIcon className="size-4" />,
  error: <XIcon className="size-4" />,
};

function PromptInputSubmit({
  variant = "default",
  size = "icon-sm",
  status = "ready",
  onStop,
  onClick,
  children,
  sendLabel = "Submit",
  stopLabel = "Stop",
  ...props
}: React.ComponentProps<typeof InputGroupButton> & {
  status?: PromptInputStatus;
  /** Stops the answer: while one is coming, the button stops instead of sending. */
  onStop?: () => void;
  sendLabel?: string;
  stopLabel?: string;
}) {
  const answering = status === "submitted" || status === "streaming";
  const stops = answering && onStop !== undefined;
  // While an answer is coming and nothing can stop it, nothing is sent.
  return (
    <InputGroupButton
      {...props}
      // What it does follows the status, whatever else it is given.
      data-slot="prompt-input-submit"
      aria-label={stops ? stopLabel : sendLabel}
      onClick={(event) => {
        onClick?.(event);
        if (stops && !event.defaultPrevented) {
          event.preventDefault();
          onStop();
        }
      }}
      size={size}
      type={stops ? "button" : "submit"}
      variant={variant}
      disabled={(answering && !stops) || props.disabled}
    >
      {children ?? statusIcons[status]}
    </InputGroupButton>
  );
}

export {
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputAttachmentsContext,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputAttachments,
  type PromptInputButtonTooltip,
  type PromptInputStatus,
};

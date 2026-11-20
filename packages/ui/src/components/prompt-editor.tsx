"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import { Popover, PopoverContent } from "@grasp-os/ui/components/popover";
import { cn } from "@grasp-os/ui/lib/utils";
import { Extension } from "@tiptap/core";
import type { Editor, JSONContent } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Mention } from "@tiptap/extension-mention";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { CharacterCount, Placeholder, UndoRedo } from "@tiptap/extensions";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionProps } from "@tiptap/suggestion";
import { cva } from "class-variance-authority";
import * as React from "react";

// The box to ask in as an editor of plain text with mentions in it: typed
// after a trigger (`@`, later `/`), a dropdown lists what may be mentioned,
// narrowing as the person types, picked with the arrow keys and Enter or a
// click, and what is picked stands as a chip in the text where it was
// typed, removed whole. Each kind of thing mentioned (an App, a workflow,
// a person, a command) has its icon and its hue (`--mention-*`). TipTap's
// MIT core on ProseMirror, lean: paragraphs, line breaks, undo, a
// placeholder and a length; no formatting. Enter sends, Shift+Enter starts
// a new line; pasted files and Backspace in an empty box are the page's.
//
//   <PromptEditor
//     kinds={{ app: { label: "Apps", icon: <AppIcon />, tone: "app" } }}
//     triggers={[{ char: "@", suggest: (query) => apps.filter(…) }]}
//     value={text}
//     onChange={({ text, mentions }) => …}
//     onSubmit={send}
//   />

/** The hue of a kind of mention (the theme's `--mention-*`). */
export type PromptMentionTone =
  | "app"
  | "workflow"
  | "person"
  | "agent"
  | "command";

/** How a kind of mention shows: in the dropdown's groups, and as a chip. */
export interface PromptMentionKind {
  /** The dropdown group's heading. */
  label: string;
  icon: React.ReactNode;
  tone: PromptMentionTone;
}

/** Something that may be mentioned, as the dropdown lists it. */
export interface PromptSuggestion {
  kind: string;
  id: string;
  label: string;
  /** A line under the label, such as a person's role. */
  description?: string;
}

/** A mention in the text: what was picked, and the trigger it was typed after. */
export interface PromptMention {
  kind: string;
  id: string;
  label: string;
  trigger: string;
}

/** A character that opens the dropdown, and what it lists for what follows it. */
export interface PromptTrigger {
  char: string;
  /** What may be mentioned for `query`, what was typed after `char`. */
  suggest: (query: string) => readonly PromptSuggestion[];
  /** What the dropdown says when nothing matches. */
  empty: string;
}

/** The text as it is sent, and the mentions in it. */
export interface PromptContent {
  /** Plain text: each mention as its trigger and label (`@Invoices`). */
  text: string;
  mentions: PromptMention[];
}

/** What a page does to the box from outside it. */
export interface PromptEditorHandle {
  /** Puts `suggestion` where the cursor is, as a chip, typed after `trigger`. */
  insertMention: (suggestion: PromptSuggestion, trigger: string) => void;
  focus: () => void;
}

/** The most suggestions the dropdown lists at once: typing narrows them. */
const SUGGESTIONS_SHOWN = 20;

// A chip in the text: shorter than the line, so lowered a little from the
// baseline to stand centred on the words beside it.
const promptChipVariants = cva(
  "inline-flex max-w-full items-center gap-1 rounded-sm px-1 align-[-0.15em] text-[0.9em] leading-tight font-medium whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        app: "bg-mention-app/12 text-mention-app",
        workflow: "bg-mention-workflow/12 text-mention-workflow",
        person: "bg-mention-person/12 text-mention-person",
        agent: "bg-mention-agent/12 text-mention-agent",
        command: "bg-mention-command/12 text-mention-command",
      },
    },
    defaultVariants: { tone: "app" },
  }
);

/** A mention as a chip: its kind's icon and hue, and its label. */
function PromptChip({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & { tone: PromptMentionTone }) {
  return (
    <span
      data-slot="prompt-chip"
      data-tone={tone}
      className={cn(promptChipVariants({ tone }), className)}
      {...props}
    />
  );
}

/** How each kind of mention shows, for the chips in the editor. */
const KindsContext = React.createContext<
  Readonly<Record<string, PromptMentionKind>>
>({});

/** A text attribute of `node`; empty where it has none. */
function textAttr(node: ProseMirrorNode, name: string): string {
  const attr: unknown = node.attrs[name];
  return typeof attr === "string" ? attr : "";
}

/** A mention in the editor, drawn as its kind's chip. */
function MentionChip({ node }: NodeViewProps) {
  const shown = React.use(KindsContext)[textAttr(node, "kind")];
  return (
    <NodeViewWrapper
      as="span"
      className="inline"
      data-kind={textAttr(node, "kind")}
    >
      <PromptChip tone={shown?.tone ?? "app"}>
        {shown?.icon}
        <span className="truncate">{textAttr(node, "label")}</span>
      </PromptChip>
    </NodeViewWrapper>
  );
}

/** The mention node: TipTap's, with the kind of what it mentions. */
const KindMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      kind: {
        default: null,
        parseHTML: (element: HTMLElement) => element.dataset.kind ?? null,
        renderHTML: (attributes: { kind?: string | null }) =>
          attributes.kind === null || attributes.kind === undefined
            ? {}
            : { "data-kind": attributes.kind },
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(MentionChip, { as: "span" });
  },
  // No dropdown of its own: the triggers (`promptTriggers`) list what can
  // be mentioned.
  addProseMirrorPlugins() {
    return [];
  },
});

/** The text `editor` holds, as it is sent, and the mentions in it, each once. */
function contentOf(editor: Editor): PromptContent {
  const mentions = new Map<string, PromptMention>();
  editor.state.doc.descendants((node) => {
    if (node.type.name === KindMention.name) {
      const kind = textAttr(node, "kind");
      const id = textAttr(node, "id");
      mentions.set(`${kind}:${id}`, {
        kind,
        id,
        label: textAttr(node, "label"),
        trigger: textAttr(node, "mentionSuggestionChar"),
      });
    }
  });
  return {
    text: editor.getText({ blockSeparator: "\n" }),
    mentions: [...mentions.values()],
  };
}

/**
 * One line of text as the editor's content: each of `mentions` where it is
 * typed (its trigger and label) a chip, the rest text.
 */
function lineOf(
  line: string,
  mentions: readonly PromptMention[]
): JSONContent[] {
  const [found] = mentions
    .map((mention) => ({
      mention,
      typed: `${mention.trigger}${mention.label}`,
      at: line.indexOf(`${mention.trigger}${mention.label}`),
    }))
    .filter(({ at }) => at !== -1)
    // The first, and of those there, the longest.
    .toSorted((a, b) => a.at - b.at || b.typed.length - a.typed.length);
  if (found === undefined) {
    return line === "" ? [] : [{ type: "text", text: line }];
  }
  const { mention, typed, at } = found;
  return [
    ...(at === 0 ? [] : [{ type: "text", text: line.slice(0, at) }]),
    {
      type: KindMention.name,
      attrs: {
        kind: mention.kind,
        id: mention.id,
        label: mention.label,
        mentionSuggestionChar: mention.trigger,
      },
    },
    ...lineOf(line.slice(at + typed.length), mentions),
  ];
}

/**
 * `text` as the editor's content: a paragraph a line, each of `mentions`
 * a chip where it is typed, as another box with the same text had it.
 */
function documentOf(
  text: string,
  mentions: readonly PromptMention[]
): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => {
      const content = lineOf(line, mentions);
      return {
        type: "paragraph",
        ...(content.length === 0 ? {} : { content }),
      };
    }),
  };
}

/** The files pasted, if any. */
function pastedFiles(event: ClipboardEvent): File[] {
  return [...(event.clipboardData?.items ?? [])].flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file === null ? [] : [file];
  });
}

/** Where no trigger opens a dropdown, and no kind is shown. */
const noTriggers: readonly PromptTrigger[] = [];
const noKinds: Readonly<Record<string, PromptMentionKind>> = {};
const noMentions: readonly PromptMention[] = [];

/** A mention of `suggestion`, typed after `trigger`, and a space after it. */
function mentionOf(
  suggestion: PromptSuggestion,
  trigger: string
): JSONContent[] {
  return [
    {
      type: KindMention.name,
      attrs: { ...suggestion, mentionSuggestionChar: trigger },
    },
    { type: "text", text: " " },
  ];
}

/** The dropdown as the editor opened it: for which trigger, what it lists, and where. */
interface Opened {
  trigger: string;
  items: readonly PromptSuggestion[];
  command: (item: PromptSuggestion) => void;
  rect: (() => DOMRect | null) | null;
}

/**
 * What the editor tells the component through its own element, as DOM
 * events: TipTap keeps the handlers it was made with, so they ask the
 * component, which answers with what it has now (`useEffectEvent`).
 */
const PROMPT_EVENT = {
  /** Enter, after the dropdown had its say. */
  submit: "prompt:submit",
  /** Backspace in an empty box; taken where cancelled. */
  backspaceEmpty: "prompt:backspace-empty",
  /** Files pasted (`detail`); taken where cancelled. */
  files: "prompt:files",
  /** What a trigger lists for a query (`detail`, its `items` filled in). */
  suggest: "prompt:suggest",
  /** The dropdown opened, moved or closed (`detail`: `Opened`, or null). */
  dropdown: "prompt:dropdown",
  /** A key while the dropdown is open (`detail`); taken where cancelled. */
  dropdownKey: "prompt:dropdown-key",
} as const;

/** A question to a trigger: what it lists for `query`, filled in by the component. */
interface SuggestRequest {
  char: string;
  query: string;
  items: readonly PromptSuggestion[];
}

/** Tells the component `type`, with `detail`; whether it took it (cancelled). */
function tell(dom: Element, type: string, detail?: unknown): boolean {
  return !dom.dispatchEvent(
    new CustomEvent(type, { detail, cancelable: true })
  );
}

/**
 * Enter sends, after the dropdown had its say (`promptTriggers`) and
 * before TipTap's own keymap (priority 100) splits the line; Backspace in
 * an empty box is the page's, where it takes it.
 */
const PromptKeys = Extension.create({
  name: "promptKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        tell(editor.view.dom, PROMPT_EVENT.submit);
        return true;
      },
      Backspace: ({ editor }) =>
        editor.isEmpty && tell(editor.view.dom, PROMPT_EVENT.backspaceEmpty),
    };
  },
});

/**
 * Each of `chars` opens the dropdown (TipTap's Suggestion), which the
 * component lists and draws; a pick is a mention typed after its trigger.
 */
function promptTriggers(chars: readonly string[]) {
  return Extension.create({
    name: "promptTriggers",
    // Above `PromptKeys`, so Enter picks while the dropdown is open.
    priority: 1001,
    addProseMirrorPlugins() {
      const { editor } = this;
      return chars.map((char) =>
        Suggestion<PromptSuggestion, PromptSuggestion>({
          editor,
          pluginKey: new PluginKey(`prompt-trigger-${char}`),
          char,
          // Only where the person types: text set from outside (another
          // box's, carried over) opens nothing.
          allow: () => editor.view.hasFocus(),
          items: ({ query }) => {
            const asked: SuggestRequest = { char, query, items: [] };
            tell(editor.view.dom, PROMPT_EVENT.suggest, asked);
            return asked.items.slice(0, SUGGESTIONS_SHOWN);
          },
          command: ({ editor: at, range, props }) => {
            at.chain()
              .focus()
              .insertContentAt(range, mentionOf(props, char))
              .run();
          },
          render: () => {
            const show = (
              props: SuggestionProps<PromptSuggestion, PromptSuggestion>
            ) => {
              const opened: Opened = {
                trigger: char,
                items: props.items,
                command: props.command,
                rect: props.clientRect ?? null,
              };
              tell(editor.view.dom, PROMPT_EVENT.dropdown, opened);
            };
            return {
              onStart: show,
              onUpdate: show,
              onExit: () => {
                tell(editor.view.dom, PROMPT_EVENT.dropdown, null);
              },
              onKeyDown: ({ event }) =>
                tell(editor.view.dom, PROMPT_EVENT.dropdownKey, event),
            };
          },
        })
      );
    },
  });
}

/** Files pasted are the page's (`PROMPT_EVENT.files`); a paste of files alone types nothing. */
function handlePaste(view: EditorView, event: ClipboardEvent): boolean {
  const files = pastedFiles(event);
  if (files.length === 0 || !tell(view.dom, PROMPT_EVENT.files, files)) {
    return false;
  }
  // Text pasted with the files is still typed in.
  return event.clipboardData?.getData("text/plain") === "";
}

/** Whether `value` is a question to a trigger (`SuggestRequest`). */
function isSuggestRequest(value: unknown): value is SuggestRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "char" in value &&
    "query" in value &&
    "items" in value
  );
}

/** Whether `value` is the dropdown as the editor opened it (`Opened`). */
function isOpened(value: unknown): value is Opened {
  return (
    typeof value === "object" &&
    value !== null &&
    "trigger" in value &&
    "items" in value &&
    "command" in value
  );
}

const promptEditorVariants = cva(
  "[&_p.is-editor-empty:first-child]:before:text-muted-foreground w-full overflow-y-auto text-sm outline-none [&_.ProseMirror]:outline-none [&_p]:min-h-[1lh] [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
  {
    variants: {
      size: {
        // The box spaced for the page (PromptInputTextarea's room).
        prompt: "max-h-48 min-h-16 px-4.5 pt-3.5 pb-2",
        // One line in the input group's own spacing.
        compact: "max-h-40 px-3 py-2",
        // One line in a prompt bar, as an input is: each line as wide as
        // what it holds, so it never wraps, and what runs past the end
        // scrolls.
        bar: "scroll-fade-x scrollbar-none overflow-x-auto overflow-y-hidden px-1 [&_p]:w-max",
      },
    },
    defaultVariants: { size: "prompt" },
  }
);

/**
 * The box to ask in, with mentions: `value` is its plain text, which the
 * page holds (emptied after a send, it empties), and `mentions` what it
 * mentions, chips where their trigger and label are typed, so text one box
 * had shows the same in another; `onChange` gets the text and the mentions
 * as the person types. `triggers` open the dropdown; `kinds` say how each
 * kind of mention shows.
 */
function PromptEditor({
  value,
  mentions = noMentions,
  onChange,
  onSubmit,
  triggers = noTriggers,
  kinds = noKinds,
  label,
  describedBy,
  placeholder,
  maxLength,
  size = "prompt",
  onPasteFiles,
  onBackspaceEmpty,
  className,
  ref,
}: {
  value: string;
  mentions?: readonly PromptMention[];
  onChange: (content: PromptContent) => void;
  onSubmit: () => void;
  triggers?: readonly PromptTrigger[];
  kinds?: Readonly<Record<string, PromptMentionKind>>;
  label: string;
  describedBy?: string;
  placeholder?: string;
  maxLength?: number;
  size?: "prompt" | "compact" | "bar";
  /** Files pasted into it: a paste of files alone types nothing. */
  onPasteFiles?: (files: File[]) => void;
  /** Backspace in it while it is empty, as to take off the last file. */
  onBackspaceEmpty?: () => void;
  className?: string;
  ref?: React.Ref<PromptEditorHandle>;
}) {
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const [active, setActive] = React.useState(0);
  const editor = useEditor({
    content: documentOf(value, mentions),
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      CharacterCount.configure(
        maxLength === undefined ? {} : { limit: maxLength }
      ),
      KindMention.configure({
        deleteTriggerWithBackspace: true,
        renderText: ({ node }) =>
          `${textAttr(node, "mentionSuggestionChar")}${textAttr(node, "label")}`,
      }),
      promptTriggers(triggers.map(({ char }) => char)),
      PromptKeys,
    ],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        ...(describedBy === undefined
          ? {}
          : { "aria-describedby": describedBy }),
        "data-slot": "input-group-control",
        class: cn(promptEditorVariants({ size }), className),
      },
      handlePaste,
    },
  });

  const items = opened?.items ?? [];
  const pick = (index: number): void => {
    const item = items[index];
    if (opened !== null && item !== undefined) {
      opened.command(item);
    }
  };
  /** A key while the dropdown is open; whether it was the dropdown's. */
  const dropdownKey = (key: KeyboardEvent): boolean => {
    if (opened === null) {
      return false;
    }
    if (key.key === "ArrowDown" || key.key === "ArrowUp") {
      const step = key.key === "ArrowDown" ? 1 : -1;
      setActive((now) =>
        items.length === 0 ? 0 : (now + step + items.length) % items.length
      );
      return true;
    }
    if (key.key === "Enter" || key.key === "Tab") {
      if (items.length === 0) {
        return key.key === "Enter";
      }
      pick(active);
      return true;
    }
    return false;
  };
  // What the editor tells, answered with what the page has now.
  const changed = React.useEffectEvent(() => {
    if (editor !== null) {
      onChange(contentOf(editor));
    }
  });
  const told = React.useEffectEvent((event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    switch (event.type) {
      case PROMPT_EVENT.submit: {
        onSubmit();
        return;
      }
      case PROMPT_EVENT.backspaceEmpty: {
        if (onBackspaceEmpty !== undefined) {
          event.preventDefault();
          onBackspaceEmpty();
        }
        return;
      }
      case PROMPT_EVENT.files: {
        if (onPasteFiles !== undefined && Array.isArray(detail)) {
          event.preventDefault();
          onPasteFiles(detail.filter((each) => each instanceof File));
        }
        return;
      }
      case PROMPT_EVENT.suggest: {
        if (isSuggestRequest(detail)) {
          detail.items =
            triggers
              .find((each) => each.char === detail.char)
              ?.suggest(detail.query) ?? [];
        }
        return;
      }
      case PROMPT_EVENT.dropdown: {
        setActive(0);
        setOpened(isOpened(detail) ? detail : null);
        return;
      }
      case PROMPT_EVENT.dropdownKey: {
        if (detail instanceof KeyboardEvent && dropdownKey(detail)) {
          event.preventDefault();
        }
        break;
      }
      default:
    }
  });
  React.useEffect(() => {
    // None yet, or one a remount took down: TipTap makes the next.
    if (editor === null || editor.isDestroyed) {
      return () => {
        // No editor yet: nothing to listen to.
      };
    }
    const { dom } = editor.view;
    const types = Object.values(PROMPT_EVENT);
    for (const type of types) {
      dom.addEventListener(type, told);
    }
    editor.on("update", changed);
    return () => {
      for (const type of types) {
        dom.removeEventListener(type, told);
      }
      editor.off("update", changed);
    };
  }, [editor]);

  // Text set from outside (emptied after a send, say) is what it holds.
  React.useEffect(() => {
    if (
      editor !== null &&
      !editor.isDestroyed &&
      contentOf(editor).text !== value
    ) {
      editor.commands.setContent(documentOf(value, mentions), {
        emitUpdate: false,
      });
    }
  }, [editor, value, mentions]);

  React.useImperativeHandle(ref, () => ({
    insertMention: (suggestion, trigger) => {
      editor
        ?.chain()
        .focus()
        .insertContent(mentionOf(suggestion, trigger))
        .run();
    },
    focus: () => {
      editor?.commands.focus();
    },
  }));

  // The dropdown's groups: what it lists, by kind, in the order of `kinds`.
  const groups = Object.entries(kinds).flatMap(([kind, shown]) => {
    const listed = items.filter((item) => item.kind === kind);
    return listed.length === 0 ? [] : [{ kind, shown, listed }];
  });
  const activeItem = items[active];
  const rect = opened?.rect ?? null;
  return (
    <>
      <KindsContext value={kinds}>
        <EditorContent editor={editor} className="contents" />
      </KindsContext>
      <Popover
        open={opened !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOpened(null);
          }
        }}
      >
        <PopoverContent
          align="start"
          anchor={
            rect === null
              ? null
              : { getBoundingClientRect: () => rect() ?? new DOMRect() }
          }
          className="w-72"
          finalFocus={false}
          initialFocus={false}
          side="top"
          variant="flush"
        >
          <Command
            loop
            shouldFilter={false}
            value={
              activeItem === undefined
                ? ""
                : `${activeItem.kind}:${activeItem.id}`
            }
          >
            <CommandList>
              <CommandEmpty>
                {triggers.find((each) => each.char === opened?.trigger)?.empty}
              </CommandEmpty>
              {groups.map(({ kind, shown, listed }) => (
                <CommandGroup heading={shown.label} key={kind}>
                  {listed.map((item) => (
                    <CommandItem
                      check={false}
                      key={item.id}
                      onMouseDown={(event) => {
                        // The editor keeps the cursor: the pick goes where it is.
                        event.preventDefault();
                      }}
                      onSelect={() => {
                        pick(items.indexOf(item));
                      }}
                      value={`${item.kind}:${item.id}`}
                    >
                      {shown.icon}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{item.label}</span>
                        {item.description === undefined ? null : (
                          <span className="text-muted-foreground truncate text-xs">
                            {item.description}
                          </span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}

export { PromptChip, PromptEditor, promptChipVariants };

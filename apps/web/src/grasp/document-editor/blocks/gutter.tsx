// The gutter of a page (DocumentEditor's `variant="page"`): beside the block under the pointer, or the
// caret's block while the page has the keys, a `+` that puts a new block under it and a handle whose
// menu turns it into another kind, duplicates, moves, deletes it, and asks Grasp again for a section
// or an Ask block. Both are the library's DropdownMenu, so each menu grows from its button. Every
// item has its keys (blocks/commands.ts); Mod+/ opens the menu for the caret's block.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  BlockHandle,
  Copy,
  Cycle,
  Plus,
  Trash,
} from "../../icons";
import { grasp, media } from "../../tokens/tokens.stylex";
import type { DocumentEditorWords } from "../words";
import { canAskAgain, startAskAgain } from "./ask-again";
import {
  blockKinds,
  deleteBlock,
  duplicateBlock,
  insertBelow,
  moveBlock,
  topBlockAt,
  turnInto,
} from "./commands";
import type { TopBlock } from "./commands";
import type { AskAgainRequest } from "./context";
import { kindIcons } from "./kinds";

/** The blocks that turn into another kind with their words kept: text, not a table, card or answer. */
const textBlocks: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
]);

const styles = stylex.create({
  gutter: {
    position: "absolute",
    insetInlineEnd: "100%",
    alignItems: "center",
    gap: grasp.space1,
    paddingInlineEnd: grasp.space2,
    // On a phone there is no room before the column (Notion drops its handle there too): the gutter
    // goes, and the menu stays one key away (Mod+/).
    display: { default: "flex", [media.belowPhone]: "none" },
    opacity: { default: 1, ":is([data-hidden])": 0 },
    pointerEvents: { default: "auto", ":is([data-hidden])": "none" },
    transitionProperty: "opacity",
    transitionDuration: grasp.durationHover,
  },
  at: (top: string) => ({ insetBlockStart: top }),
});

/** The element Tiptap draws for a top-level block. */
const elementOf = (editor: Editor, block: TopBlock) => {
  const node = editor.view.nodeDOM(block.pos);
  return node instanceof HTMLElement ? node : null;
};

/** The gutter's height above the frame's top, level with the block's first line. */
const topOf = (editor: Editor, block: TopBlock) => {
  const element = elementOf(editor, block);
  const frame = editor.view.dom.closest<HTMLElement>(
    "[data-slot=document-editor]"
  );
  if (element === null || frame === null) {
    return null;
  }
  // A line height in pixels; "normal" reads as a 24px line.
  const read = Number(getComputedStyle(element).lineHeight.replace("px", ""));
  const line = Number.isNaN(read) ? 24 : read;
  return `${element.getBoundingClientRect().top - frame.getBoundingClientRect().top + (line - 28) / 2}px`;
};

/** The top-level block under the pointer. */
const blockUnder = (editor: Editor, target: EventTarget | null) => {
  if (!(target instanceof Element) || !editor.view.dom.contains(target)) {
    return null;
  }
  const child = [...editor.view.dom.children].find((each) =>
    each.contains(target)
  );
  if (child === undefined) {
    return null;
  }
  const at = editor.view.posAtDOM(child, 0);
  return topBlockAt(editor.state, at);
};

/** Follows the block under the pointer, and the caret's block while the page has the keys. */
const useCurrentBlock = (editor: Editor, held: boolean) => {
  const [block, setBlock] = useState<TopBlock | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const frame = editor.view.dom.closest<HTMLElement>(
      "[data-slot=document-editor]"
    );
    if (frame === null) {
      return () => {
        // Nothing was watched.
      };
    }
    const move = (event: PointerEvent) => {
      setNear(true);
      if (held) {
        return;
      }
      const under = blockUnder(editor, event.target);
      if (under !== null) {
        setBlock(under);
      }
    };
    const leave = () => {
      setNear(false);
    };
    const caret = () => {
      if (!held && editor.isFocused) {
        setBlock(topBlockAt(editor.state));
      }
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerleave", leave);
    editor.on("selectionUpdate", caret);
    editor.on("focus", caret);
    return () => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerleave", leave);
      editor.off("selectionUpdate", caret);
      editor.off("focus", caret);
    };
  }, [editor, held]);
  return { block, near };
};

/** The handle's menu: turn into, duplicate, move, ask again, delete. */
const BlockMenu = ({
  editor,
  block,
  words,
  askAgain,
  onOpenChange,
}: {
  editor: Editor;
  block: TopBlock;
  words: DocumentEditorWords;
  askAgain: ((request: AskAgainRequest) => Promise<string>) | undefined;
  onOpenChange: (open: boolean) => void;
}) => (
  <DropdownMenu
    onOpenChange={(open) => {
      onOpenChange(open);
    }}
  >
    <DropdownMenuTrigger
      variant="ghost"
      size="xs"
      icon={BlockHandle}
      aria-label={words.blockMenu}
    />
    <DropdownMenuContent>
      {textBlocks.has(block.type) && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>{words.turnInto}</DropdownMenuLabel>
          {blockKinds
            .filter((kind) => kind !== "table")
            .map((kind) => (
              <DropdownMenuItem
                key={kind}
                icon={kindIcons[kind]}
                onSelect={() => {
                  turnInto(editor, block, kind);
                }}
              >
                {words.kinds[kind]}
              </DropdownMenuItem>
            ))}
        </DropdownMenuGroup>
      )}
      {textBlocks.has(block.type) && <DropdownMenuSeparator />}
      <DropdownMenuItem
        icon={Copy}
        shortcut="mod+shift+d"
        onSelect={() => {
          duplicateBlock(editor, block);
        }}
      >
        {words.duplicate}
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={ArrowUp}
        shortcut="mod+shift+arrowup"
        onSelect={() => {
          moveBlock(editor, block, "up");
        }}
      >
        {words.moveUp}
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={ArrowDown}
        shortcut="mod+shift+arrowdown"
        onSelect={() => {
          moveBlock(editor, block, "down");
        }}
      >
        {words.moveDown}
      </DropdownMenuItem>
      {askAgain !== undefined && canAskAgain(block.type) && (
        <DropdownMenuItem
          icon={Cycle}
          onSelect={() => {
            startAskAgain(editor, block, askAgain, {
              asking: words.askingAgain,
              asked: words.askedAgain,
              failed: words.askFailed,
            });
          }}
        >
          {words.askAgain}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        icon={Trash}
        variant="danger"
        shortcut="mod+shift+backspace"
        onSelect={() => {
          deleteBlock(editor, block);
        }}
      >
        {words.deleteBlock}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

/** The `+` menu: a new block of a kind under this one. */
const AddMenu = ({
  editor,
  block,
  words,
  onOpenChange,
}: {
  editor: Editor;
  block: TopBlock;
  words: DocumentEditorWords;
  onOpenChange: (open: boolean) => void;
}) => (
  <DropdownMenu
    onOpenChange={(open) => {
      onOpenChange(open);
    }}
  >
    <DropdownMenuTrigger
      variant="ghost"
      size="xs"
      icon={Plus}
      aria-label={words.addBlock}
    />
    <DropdownMenuContent>
      <DropdownMenuGroup>
        <DropdownMenuLabel>{words.insert}</DropdownMenuLabel>
        {blockKinds.map((kind) => (
          <DropdownMenuItem
            key={kind}
            icon={kindIcons[kind]}
            onSelect={() => {
              insertBelow(editor, block, kind);
            }}
          >
            {words.kinds[kind]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);

export const BlockGutter = ({
  editor,
  words,
  askAgain,
}: {
  editor: Editor;
  words: DocumentEditorWords;
  askAgain: ((request: AskAgainRequest) => Promise<string>) | undefined;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const { block, near } = useCurrentBlock(editor, menuOpen);
  // Mod+/ in the page: the handle takes the keys and opens its menu.
  useEffect(() => {
    const open = (event: Event) => {
      const { target } = event;
      const frame =
        target instanceof Element
          ? target.closest("[data-slot=document-editor]")
          : null;
      const handle =
        frame?.querySelector<HTMLElement>(
          `[data-slot=document-editor-gutter] [aria-label="${CSS.escape(words.blockMenu)}"]`
        ) ?? null;
      handle?.focus();
      handle?.click();
    };
    const { dom } = editor.view;
    dom.addEventListener("document-editor-block-menu", open);
    return () => {
      dom.removeEventListener("document-editor-block-menu", open);
    };
  }, [editor, words.blockMenu]);
  const top = block === null ? null : topOf(editor, block);
  if (block === null || top === null || !editor.isEditable) {
    return null;
  }
  const shown = near || editor.isFocused || menuOpen || focusWithin;
  return (
    <div
      data-slot="document-editor-gutter"
      data-hidden={shown ? undefined : ""}
      onFocus={() => {
        setFocusWithin(true);
      }}
      onBlur={() => {
        setFocusWithin(false);
      }}
      {...stylex.props(styles.gutter, styles.at(top))}
    >
      <AddMenu
        editor={editor}
        block={block}
        words={words}
        onOpenChange={setMenuOpen}
      />
      <BlockMenu
        editor={editor}
        block={block}
        words={words}
        askAgain={askAgain}
        onOpenChange={setMenuOpen}
      />
    </div>
  );
};

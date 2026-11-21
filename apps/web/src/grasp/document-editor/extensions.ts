// What DocumentEditor writes with: Tiptap's StarterKit (paragraphs, headings 1 to 3, lists, quote,
// code, bold, italic, link), a collapsible section, a placeholder, and Markdown in and out. Each node
// wears Markdown's own styles as its class (markdown/styles.ts), so what you write reads as what is
// shown. Built once per editor; the words are read through a getter, so a change of language reaches
// the next drawing without a new editor.
import * as stylex from "@stylexjs/stylex";
import {
  Details,
  DetailsContent,
  DetailsSummary,
} from "@tiptap/extension-details";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { InputRule } from "@tiptap/react";
import type {
  AnyExtension,
  JSONContent,
  MarkdownLexerConfiguration,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";

import { focus } from "../focus/focus";
import { ChevronRight } from "../icons";
import { sectionStyles } from "../markdown/section.styles";
import { markdownStyles } from "../markdown/styles";
import { Ask } from "./blocks/ask";
import { Callout } from "./blocks/callout";
import { BlockCommands } from "./blocks/commands";
import { Embed } from "./blocks/embed";
import { SlashMenuKeys } from "./blocks/slash";
import { editorStyles } from "./styles";
import type { DocumentEditorWords } from "./words";

/** The words the extensions say, kept for the life of one editor and given anew when they change. */
export class WordsHolder {
  #words: DocumentEditorWords;
  constructor(words: DocumentEditorWords) {
    this.#words = words;
  }
  get(): DocumentEditorWords {
    return this.#words;
  }
  set(words: DocumentEditorWords): void {
    this.#words = words;
  }
}

/** Whether a token's field holds tokens: the section's tokenizer puts its summary's there. */
const isTokens = (value: unknown): value is MarkdownToken[] =>
  Array.isArray(value);

const classOf = (...styles: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...styles).className ?? "";

/** A section in Markdown, as GitHub renders it: `<details>`, its `<summary>` line, then its body. */
const DETAILS =
  /^<details>[ \t]*\n?[ \t]*<summary>(?<summary>[^\n]*?)<\/summary>[ \t]*\n(?<body>[\s\S]*?)\n?<\/details>[ \t]*(?:\n|$)/u;

const SVG = "http://www.w3.org/2000/svg";

/** Hugeicons' attribute names, as SVG writes them (`strokeLinecap` is `stroke-linecap`). */
const svgName = (name: string) =>
  name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/**
 * The section's chevron (ChevronRight in its turning holder), drawn into Tiptap's own toggle button
 * as Markdown draws it with Icon: the token's stroke on the svg, so each part's own stroke is left out.
 */
const drawChevron = (toggle: HTMLElement) => {
  const holder = document.createElement("span");
  holder.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", classOf(sectionStyles.drawing));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attrs] of ChevronRight) {
    const part = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name !== "key" && name !== "stroke" && name !== "strokeWidth") {
        part.setAttribute(svgName(name), String(value));
      }
    }
    svg.append(part);
  }
  holder.append(svg);
  toggle.replaceChildren(holder);
  return holder;
};

/** The collapsible section: Tiptap's, written as GitHub's `<details>` and opened by `>>> ` or ⇧⌘6. */
const section = (words: WordsHolder) =>
  Details.extend({
    markdownTokenizer: {
      name: "details",
      level: "block",
      start: (source: string) => source.indexOf("<details>"),
      tokenize: (
        source: string,
        _tokens: MarkdownToken[],
        lexer: MarkdownLexerConfiguration
      ) => {
        const match = DETAILS.exec(source);
        return match === null
          ? undefined
          : {
              type: "details",
              raw: match[0],
              summaryTokens: lexer.inlineTokens(
                (match.groups?.summary ?? "").trim()
              ),
              tokens: lexer.blockTokens((match.groups?.body ?? "").trim()),
            };
      },
    },
    parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
      const summaryTokens = isTokens(token.summaryTokens)
        ? token.summaryTokens
        : [];
      const body = helpers.parseChildren(token.tokens ?? []);
      return {
        type: "details",
        content: [
          {
            type: "detailsSummary",
            content: helpers.parseInline(summaryTokens),
          },
          {
            type: "detailsContent",
            content: body.length > 0 ? body : [{ type: "paragraph" }],
          },
        ],
      };
    },
    renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => {
      const [summary, body] = node.content ?? [];
      const title = helpers
        .renderChildren(summary?.content ?? [])
        .replaceAll("\n", " ");
      // An empty paragraph left at the body's end (the one Enter opens) writes nothing.
      const inside = helpers.renderChildren(body?.content ?? [], "\n\n").trim();
      return `<details>\n<summary>${title}</summary>\n\n${inside}\n\n</details>`;
    },
    addInputRules() {
      return [
        new InputRule({
          find: /^>>>\s$/u,
          handler: ({ range, chain }) => {
            chain()
              .deleteRange(range)
              .setDetails()
              .updateAttributes("details", { open: true })
              .run();
          },
        }),
      ];
    },
    // Tiptap's view, drawn open, opens itself a moment later by a plain toggle; when the open state
    // came in first (`>>> ` sets it at once), that toggle shut the section, and Enter in its summary
    // then left it (the old "Meals" flake). After that toggle, the drawing follows the node again.
    addNodeView() {
      const parent = this.parent?.();
      if (parent === undefined || parent === null) {
        return null;
      }
      return (props) => {
        const view = parent(props);
        const own = view.update?.bind(view);
        let latest = props.node;
        if (own !== undefined) {
          view.update = (node, decorations, inner) => {
            const kept = own(node, decorations, inner);
            if (kept) {
              latest = node;
            }
            return kept;
          };
          setTimeout(() => {
            own(latest, [], props.innerDecorations);
          }, 0);
        }
        return view;
      };
    },
    addKeyboardShortcuts() {
      return {
        ...this.parent?.(),
        "Mod-Shift-6": () =>
          this.editor
            .chain()
            .setDetails()
            .updateAttributes("details", { open: true })
            .run(),
      };
    },
  }).configure({
    persist: true,
    HTMLAttributes: { class: classOf(sectionStyles.section) },
    renderToggleButton: ({ element, isOpen }) => {
      element.setAttribute("aria-expanded", String(isOpen));
      element.setAttribute(
        "aria-label",
        isOpen ? words.get().collapse : words.get().expand
      );
      element.className = classOf(sectionStyles.toggle, focus.ring);
      // The holder of the summary and the body gives way, so they stand in the section's grid.
      // Set once: ProseMirror reads a change to it as an edit and draws the section again.
      const holder = element.nextElementSibling;
      const holderClass = classOf(editorStyles.detailsHolder);
      if (holder !== null && holder.getAttribute("class") !== holderClass) {
        holder.setAttribute("class", holderClass);
      }
      const chevron = element.querySelector("span") ?? drawChevron(element);
      chevron.setAttribute(
        "class",
        classOf(sectionStyles.chevron, isOpen && sectionStyles.chevronOpen)
      );
      // Tiptap draws the button again on each change: its listeners are added once.
      if (element.dataset.wired === undefined) {
        element.dataset.wired = "";
        // A press opens or closes the section and leaves the caret where it was: taking focus on
        // the way down swallowed the first press's click.
        element.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        // Enter and Space on the button are the button's, not a new line in the document.
        element.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            element.click();
          }
        });
      }
    },
  });

/** Every extension one editor writes with. */
export const editorExtensions = (words: WordsHolder): AnyExtension[] => [
  StarterKit.configure({
    underline: false,
    heading: {
      levels: [1, 2, 3],
      HTMLAttributes: {
        class: classOf(markdownStyles.heading, editorStyles.heading),
      },
    },
    paragraph: { HTMLAttributes: { class: classOf(markdownStyles.paragraph) } },
    bulletList: {
      HTMLAttributes: {
        class: classOf(markdownStyles.list, markdownStyles.unordered),
      },
    },
    orderedList: {
      HTMLAttributes: {
        class: classOf(markdownStyles.list, markdownStyles.ordered),
      },
    },
    listItem: { HTMLAttributes: { class: classOf(markdownStyles.item) } },
    blockquote: { HTMLAttributes: { class: classOf(markdownStyles.quote) } },
    horizontalRule: { HTMLAttributes: { class: classOf(markdownStyles.rule) } },
    code: { HTMLAttributes: { class: classOf(markdownStyles.inlineCode) } },
    codeBlock: { HTMLAttributes: { class: classOf(editorStyles.codeBlock) } },
    bold: { HTMLAttributes: { class: classOf(markdownStyles.strong) } },
    italic: { HTMLAttributes: { class: classOf(markdownStyles.emphasis) } },
    strike: { HTMLAttributes: { class: classOf(markdownStyles.deleted) } },
    link: {
      openOnClick: false,
      autolink: true,
      HTMLAttributes: {
        class: classOf(editorStyles.link),
        rel: "noopener noreferrer",
      },
    },
  }),
  section(words),
  DetailsSummary.configure({
    HTMLAttributes: { class: classOf(sectionStyles.summary) },
  }),
  DetailsContent.configure({
    HTMLAttributes: { class: classOf(sectionStyles.body) },
  }),
  Placeholder.configure({
    emptyNodeClass: classOf(editorStyles.placeholder),
    includeChildren: true,
    placeholder: ({ editor, node }) => {
      if (node.type.name === "heading") {
        return words.get().headingPlaceholder;
      }
      if (node.type.name === "detailsSummary") {
        return words.get().summaryPlaceholder;
      }
      return editor.isEmpty ? words.get().placeholder : "";
    },
  }),
  TableKit.configure({
    table: {
      resizable: false,
      HTMLAttributes: { class: classOf(editorStyles.table) },
    },
    tableRow: { HTMLAttributes: { class: classOf(editorStyles.tableRow) } },
    tableCell: { HTMLAttributes: { class: classOf(editorStyles.tableCell) } },
    tableHeader: {
      HTMLAttributes: {
        class: classOf(editorStyles.tableCell, editorStyles.tableHead),
      },
    },
  }),
  Callout,
  Embed,
  Ask,
  BlockCommands,
  SlashMenuKeys,
  Markdown,
];

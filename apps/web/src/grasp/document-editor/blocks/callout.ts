import * as stylex from "@stylexjs/stylex";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { Node } from "@tiptap/react";
import type {
  JSONContent,
  MarkdownLexerConfiguration,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from "@tiptap/react";

import { Alert as Warning, Done, Failed, Info, Star } from "../../icons";
import type { IconData } from "../../icons";
import { iconVars } from "../../icons/icon.stylex";
import { grasp, media } from "../../tokens/tokens.stylex";

/** The tones, as GitHub names them. */
export const calloutTones = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
] as const;
export type CalloutTone = (typeof calloutTones)[number];

const isTone = (value: string): value is CalloutTone =>
  calloutTones.some((tone) => tone === value);

// Alert's look (alert/alert.tsx): the tint is the edge, no stroke and no shadow, the tone's icon on the
// first line in its colour, the words beside it. GitHub's five kinds take Alert's four tones.
const styles = stylex.create({
  callout: {
    [iconVars.size]: grasp.iconMd,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space3,
    alignItems: "start",
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  note: { backgroundColor: grasp.alertFillNeutral },
  tip: { backgroundColor: grasp.successSoft },
  // The brand's lavender (GitHub draws important in purple too), apart from tip's green: five kinds read as five.
  // Dark paper is green and greys any mix, so there the fill is lavender's own hue, dark and a little richer.
  important: {
    backgroundColor: `light-dark(color-mix(in oklab, ${grasp.lavender} 12%, ${grasp.paper}), oklch(from ${grasp.lavender} 0.3 0.06 h))`,
  },
  warning: { backgroundColor: grasp.attentionSoft },
  caution: { backgroundColor: grasp.dangerSoft },
  icon: {
    display: "inline-flex",
    marginBlock: `calc((1lh - ${grasp.iconMd}) / 2)`,
    userSelect: "none",
  },
  noteIcon: { color: grasp.muted },
  tipIcon: { color: grasp.success },
  importantIcon: { color: grasp.lavender },
  warningIcon: { color: grasp.attention },
  cautionIcon: { color: grasp.danger },
  drawing: {
    display: "block",
    width: iconVars.size,
    height: iconVars.size,
    stroke: "currentColor",
    strokeWidth: iconVars.stroke,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    minWidth: 0,
  },
});

const toneIcons: Record<CalloutTone, IconData> = {
  note: Info,
  tip: Done,
  important: Star,
  warning: Warning,
  caution: Failed,
};
const iconColours = {
  note: styles.noteIcon,
  tip: styles.tipIcon,
  important: styles.importantIcon,
  warning: styles.warningIcon,
  caution: styles.cautionIcon,
} as const;

const SVG = "http://www.w3.org/2000/svg";
const svgName = (name: string) =>
  name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/** The tone's icon as a DOM spec, drawn as Icon draws one (the token's stroke on the svg). */
const iconSpec = (tone: CalloutTone): DOMOutputSpec => [
  "span",
  {
    contenteditable: "false",
    "aria-hidden": "true",
    class: stylex.props(styles.icon, iconColours[tone]).className ?? "",
  },
  [
    `${SVG} svg`,
    {
      viewBox: "0 0 24 24",
      fill: "none",
      focusable: "false",
      class: stylex.props(styles.drawing).className ?? "",
    },
    ...toneIcons[tone].map(([tag, attrs]): DOMOutputSpec => [
      `${SVG} ${tag}`,
      Object.fromEntries(
        Object.entries(attrs)
          .filter(
            ([name]) =>
              name !== "key" && name !== "stroke" && name !== "strokeWidth"
          )
          .map(([name, value]) => [svgName(name), String(value)])
      ),
    ]),
  ],
];

const classOf = (tone: CalloutTone) =>
  stylex.props(styles.callout, styles[tone]).className ?? "";

/** `> [!NOTE]` and the quoted lines under it, up to the first line that is not quoted. */
const ALERT =
  /^> ?\[!(?<tone>NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n(?<body>(?:>[^\n]*(?:\n|$))*)/iu;

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: "note",
        parseHTML: (element) => element.dataset.tone ?? "note",
        renderHTML: (attributes: { tone?: string }) => ({
          "data-tone": attributes.tone ?? "note",
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-type=callout]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const tone = String(node.attrs.tone ?? "note");
    const kind = isTone(tone) ? tone : "note";
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-type": "callout",
        role: "note",
        class: classOf(kind),
      },
      iconSpec(kind),
      ["div", { class: stylex.props(styles.body).className ?? "" }, 0],
    ];
  },
  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (source: string) => source.search(/^> ?\[!/mu),
    tokenize: (
      source: string,
      _tokens: MarkdownToken[],
      lexer: MarkdownLexerConfiguration
    ) => {
      const match = ALERT.exec(source);
      return match === null
        ? undefined
        : {
            type: "callout",
            raw: match[0],
            tone: (match.groups?.tone ?? "note").toLowerCase(),
            tokens: lexer.blockTokens(
              (match.groups?.body ?? "").replaceAll(/^> ?/gmu, "").trim()
            ),
          };
    },
  },
  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    const tone =
      typeof token.tone === "string" && isTone(token.tone)
        ? token.tone
        : "note";
    const body = helpers.parseChildren(token.tokens ?? []);
    return {
      type: "callout",
      attrs: { tone },
      content: body.length > 0 ? body : [{ type: "paragraph" }],
    };
  },
  renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => {
    const tone =
      typeof node.attrs?.tone === "string" ? node.attrs.tone : "note";
    const inside = helpers.renderChildren(node.content ?? [], "\n\n").trim();
    const quoted = inside
      .split("\n")
      .map((line) => (line === "" ? ">" : `> ${line}`))
      .join("\n");
    return `> [!${tone.toUpperCase()}]\n${quoted}`;
  },
});

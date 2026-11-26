import { strToU8, zipSync } from "fflate";

import { plantedInstruction } from "./graph-teams.ts";

// Markup that hides words from the person reading it, or passes markup
// off as words, each with what a person sees of it: what a reader of
// Teams' and OneNote's HTML and Word's XML must hand the model, and no
// more. The hidden words are always the planted instruction.

/** What the person sees beside the hidden words. */
export const shownText = "Pay invoice INV-7 by Friday";

/**
 * HTML, by how it hides the instruction, with what a browser shows of it;
 * `null` for markup that would cost more than its length to parse, which
 * is refused.
 */
export const plantedHtml: Readonly<
  Record<string, { html: string; shown: string | null }>
> = {
  unclosedScript: {
    html: `<p>${shownText}</p><script>${plantedInstruction}`,
    shown: shownText,
  },
  scriptEndWithAttributes: {
    html: `<script>${plantedInstruction}</script type="end"><p>${shownText}</p>`,
    shown: shownText,
  },
  // A tag named `scr<script`, then words: a browser shows them, as the
  // person sees them, and never as a script.
  scriptInTagName: {
    html: `<p>${shownText}</p><scr<script>ipt>alert(1)</script>`,
    shown: `${shownText}\nipt>alert(1)`,
  },
  scriptInStyle: {
    html: `<style>p { color: red }<script></style>${shownText}<script>${plantedInstruction}</script>`,
    shown: shownText,
  },
  unclosedStyle: {
    html: `<p>${shownText}</p><style>p { color: red } ${plantedInstruction}`,
    shown: shownText,
  },
  commentWithBracket: {
    html: `<!-- a > b: ${plantedInstruction} --><p>${shownText}</p>`,
    shown: shownText,
  },
  unclosedComment: {
    html: `<p>${shownText}</p><!-- ${plantedInstruction}`,
    shown: shownText,
  },
  bracketInAttribute: {
    html: `<p><img alt="x > ${plantedInstruction}">${shownText}</p>`,
    shown: shownText,
  },
  markedHidden: {
    html: `<p hidden>${plantedInstruction}</p><p>${shownText}</p>`,
    shown: shownText,
  },
  notRendered: {
    html: `<p>${shownText}<title>${plantedInstruction}</title></p><dialog>${plantedInstruction}</dialog><video>${plantedInstruction}</video><canvas>${plantedInstruction}</canvas><svg><desc>${plantedInstruction}</desc><title>${plantedInstruction}</title><defs><text>${plantedInstruction}</text></defs><symbol><text>${plantedInstruction}</text></symbol><script>${plantedInstruction}</script><style>${plantedInstruction}</style></svg><math><semantics><mi>x</mi><annotation>${plantedInstruction}</annotation></semantics><script>${plantedInstruction}</script><style>${plantedInstruction}</style></math>`,
    shown: `${shownText}\nx`,
  },
  // A drawing draws only its text elements' characters, and a formula
  // its shown parts.
  drawnAlone: {
    html: `<p>${shownText}</p><svg><g>${plantedInstruction}</g>${plantedInstruction}<foo>${plantedInstruction}</foo><text hidden>Due <a>by</a> <tspan>Friday<a>!</a></tspan><rect>${plantedInstruction}</rect></text><switch><text systemLanguage="zz">${plantedInstruction}</text><g/><text>${plantedInstruction}</text></switch><filter><text>${plantedInstruction}</text></filter><linearGradient><text>${plantedInstruction}</text></linearGradient><radialGradient><text>${plantedInstruction}</text></radialGradient><g><tspan>${plantedInstruction}</tspan><a>${plantedInstruction}</a></g><text display="none">${plantedInstruction}</text><text visibility="hidden">${plantedInstruction}</text><text requiredExtensions="urn:x">${plantedInstruction}</text><foreignObject> at noon<p>soon</p><svg>${plantedInstruction}</svg></foreignObject></svg><p><math><mphantom><mi>${plantedInstruction}</mi></mphantom><semantics><mi>y</mi><mtext>${plantedInstruction}</mtext></semantics><maction><mi>z</mi><mtext>${plantedInstruction}</mtext></maction></math></p>`,
    shown: `${shownText}\nDue by Friday! at noon\nsoon\nyz`,
  },
  // What only an SVG drawing hides, a page shows.
  drawingNamesElsewhere: {
    html: "<p>Due <desc>Friday</desc> <metadata>noon</metadata></p><section>Owner</section><section>Sam</section>",
    shown: "Due Friday noon\nOwner\nSam",
  },
  neverShown: {
    html: `<noscript>${plantedInstruction}</noscript><template><p>${plantedInstruction}</p></template><iframe>${plantedInstruction}</iframe><datalist><option>${plantedInstruction}</option></datalist><div popover>${plantedInstruction}</div><object>${plantedInstruction}</object><progress>${plantedInstruction}</progress><meter>${plantedInstruction}</meter><p>${shownText}</p>`,
    shown: shownText,
  },
  // A closed `details` shows its summary alone.
  closedDetails: {
    html: `<details><summary>${shownText}</summary>${plantedInstruction}</details><details open><summary>Due</summary>soon</details>`,
    shown: `${shownText}\nDue\nsoon`,
  },
  inHead: {
    html: `<html><head><title>${plantedInstruction}</title><meta name="x" content="${plantedInstruction}"></head><body><p>${shownText}</p></body></html>`,
    shown: shownText,
  },
  // Markup written as words is words: what the person reads.
  escapedMarkup: {
    html: "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;</p>",
    shown: "<script>alert(1)</script> &lt;b&gt;",
  },
  references: {
    html: "<p>Caf&eacute; &hellip; &#0;&#xD800;&#x110000;</p>",
    shown: "Café … \uFFFD\uFFFD\uFFFD",
  },
  // A table's cells apart by a tab, whatever blocks they hold.
  cellsOfBlocks: {
    html: "<table><tr><td><p>Owner</p></td><td><p>Due</p><p>soon</p></td></tr><tr><td>Sam<td>30&nbsp;Oct</table>",
    shown: "Owner\tDue soon\nSam\t30 Oct",
  },
  wide: {
    html: `<p>${"<br>".repeat(150_000)}${shownText}</p>`,
    shown: shownText,
  },
  nestedDeepest: {
    html: `${"<span>".repeat(500)}${shownText}`,
    shown: shownText,
  },
  // Each costs its length squared to build as the standard says.
  nestedTooDeep: { html: `${"<div>".repeat(5000)}${shownText}`, shown: null },
  formattingRebuilt: {
    html: `<p>${Array.from({ length: 400 }, (_, at) => `<b id="${at}">`).join("")}</p>${"<p>x</p>".repeat(400)}`,
    shown: null,
  },
  // One element's attributes, which each rebuilt copy carries.
  attributesRebuilt: {
    html: `<p><b ${Array.from({ length: 4000 }, (_, at) => `a${at}`).join(" ")}>${"<p>x".repeat(4000)}`,
    shown: null,
  },
  // The attributes a `body` tag again adds, each time to all it has.
  bodyAttributesAdopted: {
    html: `<body ${Array.from({ length: 3000 }, (_, at) => `a${at}`).join(" ")}>${"<body>".repeat(4000)}`,
    shown: null,
  },
  // Branches the tree builder moves deeper once built (the adoption
  // agency), and elements it fosters before a table.
  movedDeeper: { html: "<i><b><div></i>".repeat(3000), shown: null },
  fostered: { html: `<table>${"<br>".repeat(20_000)}</table>`, shown: null },
  // A template's content nests inside it, however its tree holds it.
  nestedTemplates: { html: "<template>".repeat(5000), shown: null },
};

const wordNamespace =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A Word document's main part of `body`, its prefix `w` Word's. */
const documentXml = (body: string, preamble = ""): string =>
  `${xmlHeader}${preamble}<w:document xmlns:w="${wordNamespace}"><w:body>${body}</w:body></w:document>`;

const paragraph = (text: string): string =>
  `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** A .docx whose main part is `xml`. */
export const docxOf = (xml: string): Uint8Array =>
  zipSync({ "word/document.xml": strToU8(xml) });

/**
 * Word documents' XML, by how it hides the instruction, with what Word
 * shows of it; `null` for XML no Word document holds, which is refused.
 */
export const plantedWordXml: Readonly<
  Record<string, { xml: string; shown: string | null }>
> = {
  inComment: {
    xml: documentXml(
      `${paragraph(shownText)}<!-- ${paragraph(plantedInstruction)} -->`
    ),
    shown: shownText,
  },
  // `w` declared again, for elements that aren't Word's: Word shows none.
  prefixOfAnother: {
    xml: documentXml(
      `${paragraph(shownText)}<w:p xmlns:w="urn:example:not-word"><w:r><w:t>${plantedInstruction}</w:t></w:r></w:p>`
    ),
    shown: shownText,
  },
  // Word's elements under a prefix of their own are Word's still.
  ownPrefix: {
    xml: `${xmlHeader}<x:document xmlns:x="${wordNamespace}"><x:body><x:p><x:r><x:t>${shownText}</x:t></x:r></x:p></x:body></x:document>`,
    shown: shownText,
  },
  // A text box as Word writes it, and a fallback Word never shows.
  fallback: {
    xml: documentXml(
      `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps"><w:txbxContent>${paragraph(shownText)}</w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent>${paragraph(plantedInstruction)}</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>`
    ),
    // The box's paragraph, then the one that holds the box.
    shown: `${shownText}\n`,
  },
  // A run Word hides, and one whose hiding is turned off.
  vanished: {
    xml: documentXml(
      `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${plantedInstruction}</w:t></w:r><w:r><w:rPr><w:specVanish w:val="1"/></w:rPr><w:t>${plantedInstruction}</w:t></w:r><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>${shownText}</w:t></w:r></w:p><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:pict><w:txbxContent>${paragraph(plantedInstruction)}</w:txbxContent></w:pict><w:t>${plantedInstruction}</w:t></w:r></w:p>`
    ),
    // The hidden run's paragraph stands, empty.
    shown: `${shownText}\n`,
  },
  // A drawing hidden from view, its text box with it.
  hiddenDrawing: {
    xml: documentXml(
      `<w:p><w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="Box" hidden="1"/><w:txbxContent>${paragraph(plantedInstruction)}</w:txbxContent></wp:anchor></w:drawing></w:r><w:r><w:t>${shownText}</w:t></w:r></w:p>`
    ),
    shown: shownText,
  },
  // A tracked move: its text, at its new place alone.
  moved: {
    xml: documentXml(
      `<w:p><w:moveFrom w:id="1"><w:r><w:t>${shownText}</w:t></w:r></w:moveFrom></w:p><w:p><w:moveTo w:id="2"><w:r><w:t>${shownText}</w:t></w:r></w:moveTo></w:p>`
    ),
    shown: `\n${shownText}`,
  },
  // A tracked deletion, and a field's code: Word shows its result.
  deletedAndFieldCode: {
    xml: documentXml(
      `<w:p><w:del w:id="3"><w:r><w:t>${plantedInstruction}</w:t></w:r></w:del><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>${plantedInstruction}</w:t></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${shownText}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>.</w:t></w:r></w:p><w:p><w:del w:id="4"><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:del><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="w"/><mc:Fallback><w:r><w:fldChar w:fldCharType="begin"/></w:r></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>${shownText}</w:t></w:r></w:p>`
    ),
    // A field begun where Word shows nothing hides nothing after it.
    shown: `${shownText}.\n${shownText}`,
  },
  nestedDeepest: {
    xml: documentXml(
      `<w:p><w:r>${"<w:x>".repeat(100)}<w:t>${shownText}</w:t>${"</w:x>".repeat(100)}</w:r></w:p>`
    ),
    shown: shownText,
  },
  cdata: {
    xml: documentXml(
      "<w:p><w:r><w:t><![CDATA[Price <stays> at 12,40]]></w:t></w:r></w:p>"
    ),
    shown: "Price <stays> at 12,40",
  },
  tabStops: {
    xml: documentXml(
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Term:</w:t><w:tab /><w:t>24 months</w:t></w:r></w:p>'
    ),
    shown: "Term:\t24 months",
  },
  entityExpansion: {
    xml: documentXml(
      paragraph("&b;"),
      `<!DOCTYPE w:document [<!ENTITY a "${plantedInstruction}"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>`
    ),
    shown: null,
  },
  externalEntity: {
    xml: documentXml(
      paragraph("&secret;"),
      '<!DOCTYPE w:document [<!ENTITY secret SYSTEM "https://evil.test/secret">]>'
    ),
    shown: null,
  },
  // A DTD however harmless: Office Open XML allows none.
  doctype: {
    xml: documentXml(paragraph(shownText), "<!DOCTYPE w:document>"),
    shown: null,
  },
  nestedTooDeep: {
    xml: documentXml(
      `<w:p><w:r>${'<w:x xmlns:q="urn:example:q">'.repeat(600)}${"</w:x>".repeat(600)}<w:t>${shownText}</w:t></w:r></w:p>`
    ),
    shown: null,
  },
  unclosed: {
    xml: `${xmlHeader}<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>${shownText}`,
    shown: null,
  },
};

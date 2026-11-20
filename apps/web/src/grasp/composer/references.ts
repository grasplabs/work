// One grammar for references in a Composer's canonical text, version 1: `@[label](kind:id)`. The
// kind is open: `attachment` today (a picture in the text, pictures.tsx); a person, a file or an agent
// later, when mentions move onto it. One writer and one parser, with no look, so a host, ChatMessage
// and the checks read the same thing.

/** A reference in a canonical text: what kind of thing, its id, and how it reads. */
export interface ComposerReference {
  kind: string;
  id: string;
  label: string;
}

/** Writes a reference: `@[label](kind:id)`. A label's "]" and a line break are left out, so it always reads back. */
export const composerReference = (kind: string, id: string, label: string) =>
  `@[${label.replaceAll(/[\]\n]/gu, "")}](${kind}:${id})`;

/** A picture's reference, as the host gets it: `@[Image 1](attachment:<id>)`. */
export const composerPictureToken = (id: string, label: string) =>
  composerReference("attachment", id, label);

const REFERENCE = /@\[(?<label>[^\]\n]+)\]\((?<kind>[a-z]+):(?<id>[^)\s]+)\)/gu;

/** A canonical text in its parts, in order: words, and each reference. */
export const composerTextParts = (
  text: string
): (string | ComposerReference)[] => {
  const parts: (string | ComposerReference)[] = [];
  let last = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const at = match.index;
    if (at > last) {
      parts.push(text.slice(last, at));
    }
    parts.push({
      kind: match.groups?.kind ?? "",
      id: match.groups?.id ?? "",
      label: match.groups?.label ?? "",
    });
    last = at + match[0].length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
};

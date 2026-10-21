// How core sends a stored file's bytes to be saved, never shown: an App's
// file (app-file-route.ts) or a run's (workflows/run-file-downloads.ts).

/** What RFC 8187's attr-char leaves out and `encodeURIComponent` doesn't. */
const notAttrChar = /['()*]/gu;

/**
 * `Content-Disposition` for bytes saved as `saved` (a name already ending
 * in its type's extension): an attachment, ASCII first and the name in
 * full after.
 */
export const attachmentDisposition = (saved: string): string => {
  const fallback = saved.replaceAll(/[^\u0020-\u007E]|["\\]/gu, "_");
  const encoded = encodeURIComponent(saved).replaceAll(
    notAttrChar,
    (character) =>
      `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/** The `Content-Type` a file of `type` is sent with: text as UTF-8. */
export const attachmentContentType = (type: string): string =>
  type.startsWith("text/") ? `${type}; charset=utf-8` : type;

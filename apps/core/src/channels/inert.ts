// What the model wrote, as a chat app shows it: inert (GRA-1914). A link
// the model writes could lead the person anywhere, and an image, or a
// link a platform previews, is fetched with no click at all, carrying
// what the model read out in its address. Text the model read can steer
// what it writes, so the rule it is given (stephen-rules.ts) holds
// nothing on its own; this holds it, whatever the model writes.
//
// The words are kept as the model wrote them. Where they are posted,
// each surface's own syntax is made inert, as its documentation states
// what it reads: an Adaptive Card's `TextBlock` reads Markdown links and
// no HTML or images, Teams' message text reads HTML too, and Slack reads
// its own `<…>` links, mentions and channels, decoding `&amp;`, `&lt;`
// and `&gt;`. So a link shows as written, its address in full, and leads
// nowhere. An address written out is words: both platforms may still make
// it clickable, and nothing fetches it (answers go with previews off), so
// it is a link the person sees whole before following.
//
// What stays: Slack parses a plain `@here`, `@channel`, `@everyone`, a
// user group's handle or `#channel` in `mrkdwn` itself, and escaping stops
// only the bracketed forms. The Slack door answers direct messages alone,
// where such a mention reaches only the person already there (GRA-1916
// makes them inert before Slack answers anywhere else).

/**
 * A `]` that an inline link or a definition goes on from. A reference
 * (`[words][name]`, `[name]`) is a link only where a definition names it,
 * and with every definition broken none does.
 */
const linkGoesOn = /\](?=[(:])/gu;

/**
 * `text` as Teams reads it on a card (`TextBlock`): every `](` and `]:`
 * broken by a space, so no inline link or definition stands, nor any
 * reference that needs one, whichever part of it the text is cut at.
 */
export const inTeams = (text: string): string =>
  text.replaceAll(linkGoesOn, "] ");

/** `text` with Slack's control characters escaped, as Slack decodes them. */
const inSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * What the model wrote (an answer, a held write's or an offered start's
 * title and values), as a card on `platform` shows it: on Teams no link
 * form a card reads, on Slack its control characters escaped.
 */
export const inertOn =
  (platform: string) =>
  (text: string): string =>
    platform === "slack" ? inSlack(text) : inTeams(text);

/**
 * What the model wrote, inside a line posted as message text on
 * `platform`: on Teams, whose message text renders HTML too, its `&`
 * escaped, then every `<`, so neither a tag nor an entity that spells one
 * stands. On Slack the line goes on a card, so the adapter adds no
 * mention of its own to it.
 */
export const inertInMessage =
  (platform: string) =>
  (text: string): string =>
    platform === "slack"
      ? inSlack(text)
      : inTeams(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;");

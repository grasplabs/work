// When to use Add connection, and when not: its page, its Markdown twin, its registry item and the
// MCP server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A sheet of providers in groups, searchable, that leads to a step for pasting one's key.",
  useWhen: [
    {
      when: "Adding one of many providers, most by an API key: an AI provider in Settings.",
    },
    {
      when: "A connection that may be added more than once: a tile already connected says Add another.",
    },
  ],
  notWhen: [
    {
      when: "Connecting the first service in place, in a card, with no sheet.",
      instead: ["connect-service"],
      source: "docs/patterns/connect-service.mdx",
    },
    {
      when: "A connected service to manage: its key, its test, its removal.",
      instead: ["setting-row"],
    },
  ],
  variants: [
    {
      name: 'opens="key"',
      when: "The default: the tile opens the key step, and ends in a chevron.",
    },
    {
      name: 'opens="host"',
      when: "The host's own way in, a sign-in: the sheet closes and onSelect runs.",
    },
    {
      name: "connected",
      when: "One is connected already: the tile ends in a quiet Add another.",
    },
    {
      name: "address",
      when: "An endpoint of your own: the key step asks for its address first.",
    },
  ],
};

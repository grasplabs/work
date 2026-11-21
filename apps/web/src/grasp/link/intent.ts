// When to use Link, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Words you press to go to another page or address, in a sentence or alone.",
  useWhen: [
    {
      when: "Words that go to another page or address: anything with an address is a link.",
      source: "docs/patterns/navigation.mdx",
    },
  ],
  notWhen: [
    {
      when: "An action: save, send, delete.",
      instead: ["button"],
      source: "docs/patterns/navigation.mdx",
    },
    {
      when: "A site's main places, grouped under a row of names.",
      instead: ["navigation-menu"],
      source: "docs/components/navigation-menu.mdx",
    },
    {
      when: "The path back up to the page someone is on.",
      instead: ["breadcrumb"],
      source: "docs/components/breadcrumb.mdx",
    },
  ],
  variants: [
    { name: 'variant="inline"', when: "The default: inside a sentence." },
    {
      name: 'variant="standalone"',
      when: "On its own line, such as View all reports.",
    },
    {
      name: "external",
      when: "It leaves the product, so it opens in a new tab.",
    },
  ],
};

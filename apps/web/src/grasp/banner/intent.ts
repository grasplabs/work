// When to use Banner, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A strip across the top of a page or app that shares news, like an outage.",
  useWhen: [
    {
      when: "News across the top of a page or the app: a notice, a warning, an outage.",
    },
  ],
  notWhen: [
    {
      when: "A note about one part of the page, set where it is.",
      instead: ["alert"],
      source: "src/components/banner/banner.tsx",
    },
    {
      when: "A receipt that something happened, for a moment.",
      instead: ["toast"],
      source: "docs/components/toast.mdx",
    },
  ],
  variants: [
    { name: 'tone="neutral"', when: "A notice: the default." },
    { name: 'tone="success"', when: "Something went well." },
    { name: 'tone="attention"', when: "A warning." },
    { name: 'tone="danger"', when: "An outage, or something that stopped." },
    {
      name: "onDismiss",
      when: "The message can be put away; remember the choice.",
    },
  ],
};

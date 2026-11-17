// When to use Scroll area, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box whose content scrolls inside it, with a thin bar that shows while in use.",
  useWhen: [{ when: "A box of a set height whose content runs past it." }],
  notWhen: [
    { when: "A whole page: the page scrolls itself." },
    { when: "Inside another scroll area that scrolls the same way." },
    {
      when: "A long list better read a page at a time.",
      instead: ["pagination", "data-table"],
      source: "docs/components/pagination.mdx",
    },
  ],
  variants: [
    { name: 'orientation="horizontal"', when: "A row wider than the box." },
    {
      name: "stickToEnd",
      when: "A chat or a log: it starts at the end and stays there as the content grows.",
    },
  ],
};

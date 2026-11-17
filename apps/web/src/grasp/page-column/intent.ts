// When to use Page column, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A page's content in one column of a reading width at the page's start, with room for a child that runs the whole width.",
  useWhen: [
    {
      when: "A settings page or a form page: a card per topic in a column about 720px wide, beside the nav.",
    },
    {
      when: "A table under them that needs the page's whole width (PageColumnWide).",
    },
  ],
  notWhen: [
    {
      when: "A page of cards or a dashboard that uses the whole width.",
      instead: ["app-shell"],
      proposed: true,
    },
    { when: "One block of running text.", instead: ["text"], proposed: true },
  ],
  variants: [
    {
      name: 'measure="page"',
      when: "Wider things, up to the page's own measure (64rem).",
    },
  ],
};

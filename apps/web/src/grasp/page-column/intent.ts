// When to use Page column, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A page's content in one column of a reading width in the page's middle, with room for a child that runs the whole width.",
  useWhen: [
    {
      when: "A settings page or a form page: a card per topic in a column about 720px wide, beside the nav.",
    },
    {
      when: "A table on a settings page: in the column, its edges on the cards' edges.",
    },
    {
      when: "Something that needs more room than the column, a wide table or a chart: PageColumnWide runs the page's whole width.",
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
      name: 'measure="settings"',
      when: "A settings page: its title and groups of rows 640px wide.",
    },
    {
      name: 'align="start"',
      when: "The column at the page's start, all the room past it at its end, where something beside the page already sets its left edge.",
    },
    {
      name: 'measure="page"',
      when: "Wider things, up to the page's own measure (64rem).",
    },
  ],
};

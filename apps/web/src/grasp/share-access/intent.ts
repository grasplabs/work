// When to use Share access, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Who has something and at what level, with a row to add more: the content of a share dialog.",
  useWhen: [
    {
      when: "Giving people, groups or the whole company access to one thing, each at a level.",
    },
  ],
  notWhen: [
    {
      when: "Choosing the one person who owns something.",
      instead: ["owner-picker"],
      proposed: true,
    },
    {
      when: "A list of people with no levels to set.",
      instead: ["row-list", "item"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: "onRemove",
      when: "Members can be taken away: each row's levels end with Remove.",
    },
    {
      name: "preview",
      when: "The receiver sees something first (a message, a card): show it under the list.",
    },
    {
      name: "onCopyLink / onDone",
      when: "The sheet ends with a link to copy and Done; leave them out when the dialog's own foot holds them.",
    },
  ],
};

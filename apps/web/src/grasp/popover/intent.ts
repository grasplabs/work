// When to use Popover, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small panel beside the control that opened it, for a quick task.",
  useWhen: [
    {
      when: "A small task beside the control that opened it, with the page still in reach.",
    },
  ],
  notWhen: [
    { when: "A task that needs the page out of the way.", instead: ["dialog"] },
    { when: "A list of commands.", instead: ["dropdown-menu"] },
    { when: "A hint that shows on hover.", instead: ["tooltip"] },
    {
      when: "A task that needs more room than a few fields, beside the page.",
      instead: ["sheet"],
      proposed: true,
    },
  ],
};

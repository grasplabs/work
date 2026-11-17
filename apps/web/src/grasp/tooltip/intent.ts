// When to use Tooltip, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A short hint that shows when you point at a control or tab to it.",
  useWhen: [
    {
      when: "A few words that add to what a control says, such as on an icon-only button.",
    },
    { when: "The keyboard shortcut of an action." },
  ],
  notWhen: [
    { when: "Anything a person needs to finish a task." },
    { when: "A link, a button or a field inside it.", instead: ["popover"] },
    { when: "Why a button is disabled: say it beside the button." },
    {
      when: "A preview of where a link goes.",
      instead: ["hover-card"],
      source: "docs/components/hover-card.mdx",
    },
  ],
};

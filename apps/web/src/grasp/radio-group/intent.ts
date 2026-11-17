// When to use Radio group, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A short list of choices where you pick exactly one, all shown at once.",
  useWhen: [{ when: "One answer from a few choices, all in view at once." }],
  notWhen: [
    { when: "More than about seven choices.", instead: ["select"] },
    { when: "One choice alone.", instead: ["checkbox"] },
    {
      when: "Choices that do something the moment they are chosen.",
      instead: ["switch", "button"],
    },
    {
      when: "A view or a setting chosen in a toolbar, that stays on.",
      instead: ["toggle"],
      source: "docs/components/toggle.mdx",
    },
  ],
};

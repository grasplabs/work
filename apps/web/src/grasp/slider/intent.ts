// When to use Slider, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A bar with a handle you drag to set a number, or two for a range.",
  useWhen: [
    { when: "A number along a scale, with its value in its own units." },
    { when: "A range: the lowest and the highest along one scale." },
  ],
  notWhen: [
    {
      when: "An exact number someone must type.",
      instead: ["number-input", "input"],
    },
    { when: "A few named choices.", instead: ["radio-group"] },
  ],
};

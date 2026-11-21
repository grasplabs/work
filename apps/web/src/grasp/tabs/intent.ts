// When to use Tabs, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A row of tabs that switch between views of one thing, one at a time.",
  useWhen: [
    {
      when: "Views of one thing, one shown at a time, each named by a short noun.",
    },
    {
      when: "Views of one thing that each have their own address: TabsNav with TabsLink, links that look like tabs.",
    },
  ],
  notWhen: [
    { when: "Going to another page.", instead: ["link"] },
    { when: "Steps in order.", instead: ["stepper", "multi-step-form"] },
    { when: "One view alone." },
  ],
  variants: [
    {
      name: 'variant="line"',
      when: "The default: views of a page, with a line under the chosen tab.",
    },
    {
      name: 'variant="segmented"',
      when: "A small switch in a toolbar, the chosen tab filled.",
    },
  ],
};

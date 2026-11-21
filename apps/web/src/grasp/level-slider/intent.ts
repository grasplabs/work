// When to use LevelSlider, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "One of a short named scale, chosen along a round track of dots, lit up to the thumb, its top level a state of its own.",
  useWhen: [
    {
      when: "How much of something, in a few named steps: effort, detail, strictness.",
      source: "handover/composer/ruben-2026-11-16/BRIEF.md",
    },
    {
      when: "A scale of two to seven levels whose order matters and whose top may be extra.",
    },
  ],
  notWhen: [
    { when: "A number along a scale, or a range.", instead: ["slider"] },
    {
      when: "Named choices with no order between them.",
      instead: ["radio-group", "select"],
    },
    { when: "A setting that is on or off.", instead: ["switch"] },
  ],
  variants: [
    { name: "regular", when: "On a page or in a form." },
    { name: "compact", when: "Inside a popup or a menu, beside other rows." },
    {
      name: "top",
      when: "The last level is the most there is, and should feel it: the working light through the dots, the thumb aglow.",
    },
  ],
};

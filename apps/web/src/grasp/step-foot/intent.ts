// When to use Step foot, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The foot of a guided flow: Back, how far through, and the step's one action.",
  useWhen: [
    {
      when: "A flow that asks one thing at a time and goes on in order (a guided setup, a questionnaire).",
    },
  ],
  notWhen: [
    {
      when: "People jump between named steps, or need to see them all.",
      instead: ["stepper"],
      source: "docs/components/stepper.mdx",
    },
    {
      when: "A form on one page, saved at once.",
      instead: ["form"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: "step",
      when: 'How far through: the bar between Back and Next, said as "Step 3 of 7".',
    },
    {
      name: "showStep",
      when: "The words shown beside the bar too, where the flow is long.",
    },
    {
      name: "finishLabel",
      when: 'The last step says what it does ("Create agent"), with no arrow.',
    },
    {
      name: "disabled with disabledReason",
      when: "Next waits for an answer: why, in its tip, and it keeps its place in the keys.",
    },
    {
      name: "loading",
      when: "Next is working: Button's own spinner, its width held.",
    },
  ],
};

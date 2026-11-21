// When to use Step bar, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The quiet bar at the top of a guided flow: Back, how far through, and Next, as ghost arrows either side of a thin progress.",
  useWhen: [
    {
      when: "A flow that asks one thing at a time and goes on in order, where the answer should stand alone (New agent's guided setup).",
    },
  ],
  notWhen: [
    {
      when: "The flow ends in a form that needs a filled action at its end.",
      instead: ["step-foot"],
      source: "docs/components/step-foot.mdx",
    },
    {
      when: "People jump between named steps, or need to see them all.",
      instead: ["stepper"],
      source: "docs/components/stepper.mdx",
    },
  ],
  variants: [
    {
      name: "step",
      when: 'How far through: the thin bar between Back and Next, said as "Step 3 of 7".',
    },
    {
      name: "showCount",
      when: '"Step 3 of 7" shown too, small and muted at the bar\'s end, where the flow is long.',
    },
    {
      name: "finishLabel",
      when: 'The last step\'s Next is a quiet word that says what it does ("Create agent").',
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

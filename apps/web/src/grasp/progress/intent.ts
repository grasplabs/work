// When to use Progress, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A bar or ring showing how far a task has come, or that it is running.",
  useWhen: [
    { when: "A task that will finish, and how far it has come." },
    {
      when: "A task under way whose length is not known yet: `value={null}` until it is.",
    },
  ],
  notWhen: [
    { when: "A reading such as storage used: that is a meter." },
    {
      when: "A short wait beside words, with no length to show.",
      instead: ["spinner"],
      source: "docs/patterns/loading.mdx",
    },
    {
      when: "Content on its way whose shape is known.",
      instead: ["skeleton"],
      source: "docs/patterns/loading.mdx",
    },
    {
      when: "Named steps, each done, current or coming.",
      instead: ["stepper"],
      source: "docs/components/stepper.mdx",
    },
  ],
  variants: [
    {
      name: 'shape="bar"',
      when: "The default: it runs the width it is given.",
    },
    { name: 'shape="ring"', when: "Beside words, or in a button's place." },
    { name: 'size="sm"', when: "A bar in a row." },
    {
      name: 'size="lg"',
      when: "A bar that is the point of its panel; a ring that holds its value.",
    },
    { name: 'tone="success"', when: "Once it has worked." },
    { name: 'tone="attention"', when: "When it is slow." },
    {
      name: 'tone="danger"',
      when: "When it stopped, with words that say why.",
    },
  ],
};

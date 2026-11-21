// When to use Question tool, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A card where an assistant asks a question and waits for the person's answer.",
  useWhen: [
    {
      when: "An assistant needs an answer it cannot find for itself: one choice, several, or a few words.",
    },
  ],
  notWhen: [
    { when: "A question whose answer the assistant could find for itself." },
    {
      when: "An agent asks for a person's yes before it acts.",
      instead: ["approval-request"],
      source: "docs/components/approval-request.mdx",
    },
    {
      when: "A question the page asks, with no assistant waiting.",
      instead: ["radio-group", "checkbox", "form"],
      proposed: true,
    },
  ],
  variants: [
    { name: 'kind="single"', when: "One answer from the choices." },
    { name: 'kind="multi"', when: "Several answers from the choices." },
    { name: 'kind="text"', when: "An answer in the person's own words." },
    { name: "columns={2}", when: "Short choices with no description." },
    {
      name: "recommended (on a choice)",
      when: "The assistant has a choice it would make itself; one at most.",
    },
    {
      name: "value / onValueChange",
      when: "Questions asked in turn, or a question whose kind can change: the answer kept across Back.",
    },
  ],
};

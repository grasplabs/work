// When to use Setting row, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A setting as one row of a settings card: its name and help at the start, its control on an edge every row shares.",
  useWhen: [
    { when: "A settings page: each topic a flush Section card of rows." },
    {
      when: "A fact nobody changes here, in the same columns as the settings: FactRow.",
    },
    {
      when: "A setting that saves when it changes: its state says Saving, Saved, or that it failed.",
    },
  ],
  notWhen: [
    { when: "A form someone fills in and sends at once.", instead: ["field"] },
    { when: "A list of things (members, providers).", instead: ["item"] },
  ],
  variants: [
    { name: "FactRow", when: "A value nobody changes here." },
    { name: "RowAlert", when: "A failure or a warning about the card's rows." },
    {
      name: 'state="failed"',
      when: "The save failed: the value is kept and Try again saves it.",
    },
  ],
};

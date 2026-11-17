// When to use Alert, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A short message in the page that tells people something is done, wrong or worth knowing.",
  useWhen: [
    {
      when: "Something to know, something done or something wrong, near what it is about.",
    },
    {
      when: "Something a person must read or act on.",
      source: "docs/components/toast.mdx",
    },
    {
      when: 'News about the whole page or the app, across its top: a notice, a warning, an outage. `variant="banner"`.',
      source: "src/components/alert/alert.tsx",
    },
  ],
  notWhen: [
    {
      when: "A result that comes and goes: the button says it on itself.",
      instead: ["button"],
    },
    {
      when: "A receipt that something happened, for a moment.",
      instead: ["toast"],
      source: "docs/components/toast.mdx",
    },
    {
      when: "What is wrong with one field of a form.",
      instead: ["field"],
      source: "src/components/field/field.tsx",
    },
  ],
  variants: [
    { name: 'tone="neutral"', when: "Something to know: the default." },
    { name: 'tone="success"', when: "It went well." },
    {
      name: 'tone="attention"',
      when: "Something to look at before it becomes a problem.",
    },
    { name: 'tone="danger"', when: "It went wrong." },
    {
      name: 'variant="banner"',
      when: "Across the top of a page or the app, about the whole of it (once Banner).",
    },
    {
      name: "onDismiss",
      when: "A banner that can be put away; remember the choice.",
    },
    {
      name: 'live="off"',
      when: "It is part of the page, read where it stands, not news: a note on a page that loads with it.",
    },
  ],
};

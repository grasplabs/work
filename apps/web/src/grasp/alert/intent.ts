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
      when: "News about the whole page or the app.",
      instead: ["banner"],
      source: "docs/components/banner.mdx",
    },
    {
      when: "What is wrong with one field of a form.",
      instead: ["field"],
      source: "src/components/field/field.tsx",
    },
  ],
  variants: [
    { name: 'variant="neutral"', when: "Something to know: the default." },
    { name: 'variant="success"', when: "It went well." },
    {
      name: 'variant="attention"',
      when: "Something to look at before it becomes a problem.",
    },
    { name: 'variant="danger"', when: "It went wrong." },
  ],
};

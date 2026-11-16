// When to use Input, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box for typing one line of text, like a name or an email address.",
  useWhen: [{ when: "One line of text, with a label that says what goes in." }],
  notWhen: [
    {
      when: "More than one sentence.",
      instead: ["textarea"],
      source: "docs/components/textarea.mdx",
    },
    {
      when: "Words, an icon or a button inside the field's edge.",
      instead: ["input-group"],
      source: "docs/components/input-group.mdx",
    },
    {
      when: "A number stepped up and down.",
      instead: ["number-input"],
      source: "docs/components/number-input.mdx",
    },
    {
      when: "A one-time code.",
      instead: ["input-otp"],
      source: "docs/components/input-otp.mdx",
    },
  ],
  variants: [
    { name: 'size="md"', when: "The default." },
    { name: 'size="sm"', when: "In a dense table or toolbar." },
    { name: 'size="lg"', when: "The one field that matters on a phone." },
    {
      name: "secret",
      when: "A value an agent may fill but must never read: a key, a token, a tax number.",
    },
    {
      name: "readOnly",
      when: "A value someone may want to copy but not change. Never disabled for it.",
    },
  ],
};

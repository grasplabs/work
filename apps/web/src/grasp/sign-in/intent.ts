// When to use Sign in, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The way into Grasp: the website's login, with a button for each identity provider the organisation has set up.",
  useWhen: [
    {
      when: "The page someone signs in on, leaving for their organisation's identity provider.",
    },
    {
      when: "Someone sent back to sign in: a session that ended, a refusal, Grasp out of reach.",
    },
  ],
  notWhen: [
    {
      when: "Only what stands behind a page.",
      instead: ["backdrop"],
      source: "docs/components/backdrop.mdx",
    },
    {
      when: "A form that asks for an email, a code or a password.",
      instead: ["form"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: 'page="staff"',
      when: "Grasp staff's own page: their way in only.",
    },
    {
      name: 'page="guest"',
      when: "Someone who is not a member: no way in, the product's chat in its place.",
    },
  ],
};

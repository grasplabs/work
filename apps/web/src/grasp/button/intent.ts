// When to use Button, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A button you press to do one thing now, like Save or Send.",
  useWhen: [
    {
      when: "A person does something here and now: save, send, approve, delete.",
    },
    {
      when: "The action takes time: with `useAction` the button says it is working, then done or failed.",
    },
    {
      when: "What deletes the thing a settings form is about: a danger button in its own section under the form, never beside Save.",
      source: "docs/patterns/forms.mdx",
    },
  ],
  notWhen: [
    {
      when: "It leads to another page or address and does nothing else.",
      instead: ["link"],
    },
    {
      when: "It turns one thing on or off and stays that way.",
      instead: ["toggle", "switch"],
      source: "docs/components/toggle.mdx",
    },
    {
      when: "Several actions for one thing, most of them rarely used.",
      instead: ["dropdown-menu"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: 'variant="ink"',
      when: "The one step you want taken in this view. Never two in one view.",
    },
    { name: 'variant="quiet"', when: "Every other action: the default." },
    {
      name: 'variant="ghost"',
      when: "Actions in a toolbar or a row, where a fill would be too heavy.",
    },
    {
      name: 'variant="approve"',
      when: "A yes to what an agent asks. Never two in one view.",
    },
    {
      name: 'variant="danger"',
      when: "An action that deletes or cannot be undone. Never for what can be undone.",
    },
    {
      name: "hold",
      when: "A small loss that cannot be undone (a draft, a member): the press itself is the yes.",
    },
    {
      name: "truncate",
      when: "A long name in a narrow head, where wrapping would push the next control off.",
    },
  ],
};

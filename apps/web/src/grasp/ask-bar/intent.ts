// When to use Ask bar, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small composer at the foot of every page that hands over to a chat docked beside the page.",
  useWhen: [
    {
      when: "Asking an assistant from any page of an app, without leaving the page.",
    },
    {
      when: "A chat that stays beside the page while the person keeps working in it.",
    },
  ],
  notWhen: [
    {
      when: "The chat is the whole page.",
      instead: ["composer", "thread"],
      source: "docs/components/composer.mdx",
    },
    {
      when: "Finding a page or running a command by name.",
      instead: ["command", "commandbar"],
      source: "docs/components/commandbar.mdx",
    },
    {
      when: "A reply box inside a conversation already on the page.",
      instead: ["composer"],
    },
  ],
  variants: [
    { name: "AskBar", when: "At rest: give it to App shell's dock." },
    {
      name: "AskBar working",
      when: "While the chat is still answering and the bar is back.",
    },
    {
      name: "AskPanel",
      when: "After the first send: give it to App shell's panels.",
    },
  ],
};

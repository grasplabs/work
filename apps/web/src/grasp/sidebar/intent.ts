// When to use Sidebar, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A column of links to an app's main pages down one side, which folds away.",
  useWhen: [
    {
      when: "A product's main places to go, in groups, with the person signed in at the foot.",
    },
  ],
  notWhen: [
    {
      when: "On a phone: it goes in a sheet.",
      instead: ["sheet", "app-shell"],
      source: "src/components/sidebar/sidebar.tsx",
    },
    {
      when: "Actions rather than places to go: a sidebar is links, not a menu.",
      instead: ["menubar", "dropdown-menu"],
      proposed: true,
    },
    {
      when: "A site's main links in a row across the top.",
      instead: ["navigation-menu"],
      source: "src/components/navigation-menu/navigation-menu.tsx",
    },
    {
      when: "Views of one thing.",
      instead: ["tabs"],
      source: "docs/patterns/navigation.mdx",
    },
  ],
};

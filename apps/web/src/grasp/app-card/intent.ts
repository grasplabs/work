// When to use App card, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A card for one app, with a picture of it, its title, owner and last change.",
  useWhen: [
    { when: "A page of the apps a team built, each opening the app." },
    {
      when: "One app shown where a person picks it up again: its home, a search result.",
    },
  ],
  notWhen: [
    {
      when: "The app itself, to use and to work on.",
      instead: ["app-preview"],
    },
    {
      when: "Only the first build, with nothing to show yet.",
      instead: ["app-building"],
    },
    {
      when: "A list of many apps to compare by their fields.",
      instead: ["data-table"],
    },
  ],
};

// When to use App preview, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A running app shown in a frame, with controls for its path, width and reloading.",
  useWhen: [
    {
      when: "An app a person or an agent built, shown running beside the work on it.",
    },
    { when: "The same app seen at phone, tablet and desktop widths." },
  ],
  notWhen: [
    {
      when: "A picture or a document of a page, not the running app.",
      instead: ["artifact-viewer"],
    },
    {
      when: "Only the first build, with nothing to run yet.",
      instead: ["app-building"],
    },
    { when: "A link to an outside site.", instead: ["link"] },
  ],
};

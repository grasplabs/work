// When to use Artifact viewer's comments item, and when not: its registry item and the MCP server
// read this one file (src/intent/README.md). A line with `proposed` is not yet confirmed.
export const intent = {
  what: "Comments for the Artifact viewer: threads on a file's words, cells and boxes, as an item of its own.",
  useWhen: [
    {
      when: "People comment on a file in the viewer: import it once beside the viewer.",
      proposed: true,
    },
  ],
  notWhen: [
    {
      when: "A file to read and download, no comments.",
      instead: ["artifact-viewer"],
      proposed: true,
    },
  ],
};

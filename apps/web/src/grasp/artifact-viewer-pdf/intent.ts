// When to use Artifact viewer's PDF item, and when not: its registry item and the MCP server read this one file
// (src/intent/README.md). A line with `proposed` is not yet confirmed.
export const intent = {
  what: "The Artifact viewer's PDF renderer, on PDF.js, as an item of its own.",
  useWhen: [
    {
      when: "PDFs open in the Artifact viewer: import it once beside the viewer.",
      proposed: true,
    },
  ],
  notWhen: [
    {
      when: "A host that shows only web pages, plain text, code and images.",
      instead: ["artifact-viewer"],
      proposed: true,
    },
  ],
};

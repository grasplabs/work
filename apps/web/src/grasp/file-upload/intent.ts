// When to use File upload, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "An area in a form where you drop or choose files, then see them listed.",
  useWhen: [{ when: "Files that belong to a form, dropped or chosen." }],
  notWhen: [
    {
      when: "Files added to a message to an assistant.",
      instead: ["composer"],
      source: "docs/components/composer.mdx",
    },
    {
      when: "A file to read or show, not to send.",
      instead: ["artifact-viewer"],
      source: "docs/components/artifact-viewer.mdx",
    },
  ],
  variants: [
    {
      name: "upload",
      when: "Each file is sent as it arrives, showing how far it is, with Try again if it fails.",
    },
    {
      name: "multiple",
      when: "More than one file. Without it, a new file takes the old one's place.",
    },
  ],
};

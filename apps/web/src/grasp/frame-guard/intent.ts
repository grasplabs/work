// When to use Frame guard, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "An iframe that keeps the page's scroll until it is asked for: a press, Enter or Tab makes it live, Escape or Done gives the page back.",
  useWhen: [
    {
      when: "An iframe that scrolls inside a page that scrolls: a running app, a rendered file.",
    },
    {
      when: "Your own frame beside App preview's and Artifact viewer's, which already lay one over theirs.",
    },
  ],
  notWhen: [
    {
      when: "A running app, with its address, widths and states.",
      instead: ["app-preview"],
    },
    {
      when: "A file or a rendered page to read.",
      instead: ["artifact-viewer"],
    },
    {
      when: 'A frame sized to its own content, with nothing to scroll: pass guard="never", or leave it out.',
      source: "src/components/frame-guard/frame-guard.tsx",
    },
  ],
};

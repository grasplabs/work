// When to use App building, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A placeholder while an app is first built, with cursors assembling it.",
  useWhen: [
    { when: "An app built for the first time, until it is ready." },
    { when: "An app artifact in the viewer whose build is not done." },
  ],
  notWhen: [
    { when: "A file loading.", instead: ["spinner"] },
    { when: "An agent working.", instead: ["working-mark"] },
    { when: "A second one in the same view." },
  ],
};

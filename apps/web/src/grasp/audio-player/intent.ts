// When to use Audio player, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A bar that plays a sound file, with a timeline, a speed button and mute.",
  useWhen: [
    {
      when: "A sound file to play, beside what it belongs to: a call, a recording.",
    },
  ],
  notWhen: [
    { when: "Sound that should start on its own." },
    { when: "Sound that matters only in the player: say it in words too." },
    {
      when: "An interview, with its transcript and the moments to hear.",
      instead: ["interview"],
      source: "docs/components/interview.mdx",
    },
  ],
};

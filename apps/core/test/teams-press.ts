import { confirmAction } from "../src/channels/cards.tsx";
import { chatAgentId } from "../src/chats-rpc.ts";
import { codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import type { Idp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import type { MailAnswer } from "./mail-server.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { member, messageFrom, post, reached } from "./teams-door.ts";

// A Teams turn that held writes, its card, and presses on it, as Teams
// sends them, for the press's tests (channels-press.test.ts) and the
// door's security suite (teams-security.test.ts).

/**
 * A member whose Teams turn held two mails, to Ben then to Cleo, on a mail
 * server that answers as `plan` says; and the card that turn sent.
 */
export const heldTurn = async (idp: Idp, plan: MailAnswer[] = []) => {
  const admin = await signedInApi(idp, "admin");
  // A send whose fields its server lists, so core can check a chat app's
  // write against them (channels/stephen-rules.ts).
  const mail = await mailConnection(plan, ["MAIL_SEND"]);
  const binding = `MAIL${unique()}`.toUpperCase();
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "connection", connectionId: mail.id },
    actions: ["MAIL_SEND"],
    binding,
  });
  const send = (to: string, subject: string) =>
    `await env.connections.call(${JSON.stringify(binding)}, "MAIL_SEND", ${JSON.stringify({ to, subject })});`;
  const person = await member(
    idp,
    codeStep(
      `export default async (self, env) => { ${send("ben@acme.test", "Invoice INV-7")} ${send("cleo@acme.test", "Reminder")} return "held"; };`
    ),
    says("Both mails wait for you to confirm them.")
  );
  await post(
    messageFrom(person.teams, {
      text: "Mail ben@acme.test the invoice and remind cleo@acme.test.",
    })
  );
  const { sent } = await reached(person.teams.conversation);
  const card = sent.findLast(
    ({ id, activity }) =>
      id !== undefined && JSON.stringify(activity).includes(confirmAction)
  );
  if (card?.id === undefined) {
    throw new Error("Expected a card of held writes");
  }
  const writes = await person.api.pendingActions.list();
  // The card's order: the order they were asked for.
  const ordered = writes.toSorted(
    (a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)
  );
  const press = ordered.map(({ id, inputHash }) => ({ id, inputHash }));
  return { person, mail, cardId: card.id, press };
};

export type Turn = Awaited<ReturnType<typeof heldTurn>>;

/** A press on the card as Teams sends it: an Action.Submit on the card's message. */
export const pressOn = (
  from: Turn["person"]["teams"],
  { cardId, press }: Pick<Turn, "cardId" | "press">,
  actionId: string = confirmAction,
  changes: Record<string, unknown> = {}
) => ({
  ...messageFrom(from, { text: undefined, ...changes }),
  replyToId: cardId,
  value: { actionId, value: JSON.stringify(press) },
});

/** How many calls reached the mail server, and to whom it sent. */
export const mailOf = async (mail: Turn["mail"]) => {
  const did = await mail.did();
  return { calls: did.calls, to: did.sent.map(({ to }) => to) };
};

/** The held writes still waiting for `person`, by id. */
export const waitingOf = async (person: Turn["person"]): Promise<string[]> => {
  const waiting = await person.api.pendingActions.list();
  return waiting.map(({ id }) => id);
};

/** The card's edits in the person's chat, each as JSON, in order. */
export const editsOf = async (turn: Turn): Promise<string[]> => {
  const { sent } = await reached(turn.person.teams.conversation);
  return sent
    .filter(({ editOf }) => editOf === turn.cardId)
    .map(({ activity }) => JSON.stringify(activity));
};

/** Lines said in the person's chat after the card, as text. */
export const linesAfterCard = async (turn: Turn): Promise<string[]> => {
  const { sent } = await reached(turn.person.teams.conversation);
  const at = sent.findIndex(({ id }) => id === turn.cardId);
  return (
    sent
      .slice(at + 1)
      .filter(({ editOf }) => editOf === undefined)
      // Not the card offering their own Microsoft 365 (connect-own.ts).
      .filter(
        ({ activity }) =>
          !JSON.stringify(activity).includes("/connect-microsoft")
      )
      .flatMap(({ activity }) =>
        activity.text === undefined ? [] : [activity.text]
      )
  );
};

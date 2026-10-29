import { describe, expect, it } from "vite-plus/test";

import { planDocumentText, signPlanText } from "../src/plan-signature.ts";
import {
  newSessionNonce,
  sessionTicketMaxMs,
  sessionTicketText,
  signSessionTicket,
  textDigest,
  verifySessionDispatch,
} from "../src/session-ticket.ts";
import type { SessionDispatch, SessionTicket } from "../src/session-ticket.ts";

// The ticket that starts a session of Grasp's agent (session-ticket.ts),
// from its threat model: a plan or ticket nobody signed, or signed by
// another key; a signed plan replayed without a ticket of its own, with
// an old ticket, or with a ticket for another plan, round or app; a
// ticket valid too long or issued ahead of the clock; a plan signature
// passed off as a ticket's.

const app = "example-hr";
const now = Date.parse("2026-10-29T09:00:00Z");

/** Bytes as standard base64. */
const base64 = (bytes: ArrayBuffer): string =>
  btoa(String.fromCodePoint(...new Uint8Array(bytes)));

/** An Ed25519 key pair: the private half as the admin keeps it, the public as CI does. */
const keyPair = async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) {
    throw new Error("Expected a key pair");
  }
  return {
    privateKey: base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: base64(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
};

const admin = await keyPair();
const other = await keyPair();

/** Plan document `round` of `forApp`, as the admin writes it. */
const planText = (forApp = app, round = 2): string =>
  planDocumentText({
    app: forApp,
    round,
    plan: {
      app: forApp,
      signIn: "api_key",
      hosts: ["api.example-hr.test"],
      actions: [],
      docs: ["https://developer.example-hr.test/docs"],
    },
  });

/** A ticket for `plan`, issued at `now`, as the admin writes it. */
const ticketFor = async (
  plan: string,
  changes: Partial<SessionTicket> = {}
): Promise<SessionTicket> => ({
  app,
  round: 2,
  plan: await textDigest(plan),
  nonce: newSessionNonce(),
  run: "build-example-hr-0123456789ab",
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + sessionTicketMaxMs).toISOString(),
  ...changes,
});

/** A dispatch of `plan` and `ticket`, each signed with `key`. */
const dispatchOf = async (
  plan: string,
  ticket: string,
  { planKey = admin.privateKey, ticketKey = admin.privateKey } = {}
): Promise<SessionDispatch> => ({
  plan,
  planSignature: await signPlanText(planKey, plan),
  ticket,
  ticketSignature: await signSessionTicket(ticketKey, ticket),
});

/** The problems with `dispatch` at `at`, or `starts` when there are none. */
const verdict = async (
  dispatch: SessionDispatch,
  at = now
): Promise<string[] | "starts"> => {
  const verified = await verifySessionDispatch(admin.publicKey, dispatch, at);
  return "problems" in verified ? verified.problems : "starts";
};

describe("a session ticket", () => {
  it("starts a session with the plan it names, both signed by the admin, within its hour", async () => {
    const plan = planText();
    const ticket = await ticketFor(plan);
    const verified = await verifySessionDispatch(
      admin.publicKey,
      await dispatchOf(plan, sessionTicketText(ticket)),
      now + 30 * 60_000
    );

    expect(
      "problems" in verified
        ? verified
        : { ticket: verified.ticket, app: verified.plan.app }
    ).toStrictEqual({ ticket, app });
  });

  it("starts nothing forged: a plan or ticket signed with another key, or no key to check with", async () => {
    const plan = planText();
    const ticket = sessionTicketText(await ticketFor(plan));

    expect({
      plan: await verdict(
        await dispatchOf(plan, ticket, { planKey: other.privateKey })
      ),
      ticket: await verdict(
        await dispatchOf(plan, ticket, { ticketKey: other.privateKey })
      ),
      noKey: await verifySessionDispatch(
        "",
        await dispatchOf(plan, ticket),
        now
      ),
    }).toStrictEqual({
      plan: ["The plan isn't signed by the admin's plan key"],
      ticket: ["The session ticket isn't signed by the admin's plan key"],
      noKey: {
        problems: [
          "CONNECTOR_PLAN_KEY isn't set, so no session can be trusted: set the repository variable to the admin's plan signing public key",
        ],
      },
    });
  });

  it("starts nothing replayed: a ticket past its hour, one valid longer, one from ahead of the clock", async () => {
    const plan = planText();
    const ticket = await ticketFor(plan);
    const longer = await ticketFor(plan, {
      expiresAt: new Date(now + sessionTicketMaxMs + 1).toISOString(),
    });
    const ahead = await ticketFor(plan, {
      issuedAt: new Date(now + 10 * 60_000).toISOString(),
      expiresAt: new Date(now + 20 * 60_000).toISOString(),
    });

    expect({
      expired: await verdict(
        await dispatchOf(plan, sessionTicketText(ticket)),
        now + sessionTicketMaxMs
      ),
      longer: await verdict(await dispatchOf(plan, sessionTicketText(longer))),
      ahead: await verdict(await dispatchOf(plan, sessionTicketText(ahead))),
    }).toStrictEqual({
      expired: ["The session ticket has expired"],
      longer: ["The session ticket is valid for longer than an hour"],
      ahead: ["The session ticket was issued in the future"],
    });
  });

  it("starts nothing for another plan: a ticket for an older round, another app, or another plan's text", async () => {
    const plan = planText();
    const older = planText(app, 1);
    const anotherApp = planText("example-crm");
    const ticket = sessionTicketText(await ticketFor(plan));

    expect({
      olderRound: await verdict(
        await dispatchOf(
          older,
          sessionTicketText(await ticketFor(plan, { round: 2 }))
        )
      ),
      anotherApp: await verdict(await dispatchOf(anotherApp, ticket)),
      anotherText: await verdict(await dispatchOf(older, ticket)),
    }).toStrictEqual({
      olderRound: [
        "The session ticket is for round 2, the plan is round 1",
        "The session ticket names another plan",
      ],
      anotherApp: [
        "The session ticket is for example-hr, the plan for example-crm",
        "The session ticket names another plan",
      ],
      anotherText: [
        "The session ticket is for round 2, the plan is round 1",
        "The session ticket names another plan",
      ],
    });
  });

  it("never takes a signed plan for a ticket, nor a ticket for a plan", async () => {
    const plan = planText();
    const ticket = sessionTicketText(await ticketFor(plan));
    const planSignature = await signPlanText(admin.privateKey, plan);
    const ticketSignature = await signSessionTicket(admin.privateKey, ticket);

    expect({
      planAsTicket: await verdict({
        plan,
        planSignature,
        ticket: plan,
        ticketSignature: planSignature,
      }),
      ticketAsPlan: await verdict({
        plan: ticket,
        planSignature: ticketSignature,
        ticket,
        ticketSignature,
      }),
    }).toStrictEqual({
      planAsTicket: ["The session ticket isn't a session ticket"],
      ticketAsPlan: ["The plan isn't a build plan"],
    });
  });
});

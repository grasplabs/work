import { v } from "@grasp-os/sdk";
import type { ValueSchema } from "@grasp-os/sdk";
import { httpActionSchemas } from "@grasp-os/shared/http-connections";
import type { CatalogContractDefinition } from "@grasp-os/shared/workflow-resources";

// The general catalog contracts every release ships (GRA-1469), installed
// with the built-ins (builtins.ts) as a built-in blueprint's are
// (`ensureReleaseContract`): published once, under a key nobody has taken,
// and never changed; a new shape is a new key. Without them a fresh
// deployment's catalog holds no model or decision contract a JSON
// workflow can bind, so the only steps a builder or the chat could write
// are a workflow's own `local:` code. Each is general, never a topic's or
// a client's: what a call does is the workflow's to say (a model step's
// instructions and output schema, an approval's prompt and input).
//
// A contract grants nothing. What serves a binding to one is still an
// admin's approval of that workflow's version: the model it reads with,
// through the model gateway and the workspace's own provider key, or who
// answers its decision.

/** The most levels of arrays and objects an approval's input nests. */
const approvalInputDepth = 5;

/** Any JSON value nesting at most `depth` levels of arrays and objects. */
const jsonUpTo = (depth: number): ValueSchema<unknown, unknown> => {
  const scalars = [v.string(), v.number(), v.boolean(), v.null()] as const;
  if (depth === 0) {
    return v.union(...scalars);
  }
  const inner = jsonUpTo(depth - 1);
  return v.union(...scalars, v.array(inner), v.record(inner));
};

/**
 * A model step: the task gives its instructions, its input and the JSON
 * Schema its output must match (`grasp.model`), and the admin's approval
 * names the model.
 */
export const modelStepContract = "grasp/model-step";

/**
 * A person's check or approval (`grasp.decision`): they see the task's
 * prompt and input, an object of any JSON, and answer whether they approve
 * (`approved`), with a comment of their own or none.
 */
export const approvalContract = "grasp/approval";

/**
 * An outside API's requests (GRA-1478, `grasp.connector`): `get` reads and
 * `send` changes, on an HTTP connection an admin approved and binds, with
 * the very schemas connect serves for one (`httpActionSchemas`), as JSON
 * Schema envelopes, which connect confirms are its own. Which origin,
 * paths and methods are reached is the connection's, never the contract's.
 * A binding is served only by a connection that serves every operation of
 * its contract, so a read-only API binds `httpReadContract`.
 */
export const httpContract = "grasp/http";

/** An outside API's reads alone (`get`), for a connection allowing no change. */
export const httpReadContract = "grasp/http-read";

/** An action's schema, as an envelope of its JSON Schema. */
const enveloped = (document: unknown): string =>
  JSON.stringify({ format: "json", document });

/** The HTTP contracts' `get`. */
const httpGet = {
  input: enveloped(httpActionSchemas.get.input),
  output: enveloped(httpActionSchemas.get.output),
  readOnly: true,
};

/**
 * A reply to a run's mail (`grasp.email.reply`, run-inboxes.ts): sent to
 * the run's reply address (`inbox.<alias>`), which the workflow gives its
 * mail as Reply-To. Who replies is whoever the mail reached.
 */
export const emailReplyContract = "grasp/email-reply";

/** The type of a reply to a run's mail. */
export const emailReplyType = "grasp.email.reply";

/** A name and address, as a message's headers give them. */
const mailbox = v.object({ name: v.string(), address: v.string() });

/**
 * What one authentication method said of a message, as Email Routing's
 * own ARC set records it (`ARC-Authentication-Results`, RFC 8617, its
 * results RFC 8601 2.7's), and
 * of which domain: SPF's of the envelope sender (`smtp.mailfrom`), DKIM's
 * of the signature (`header.d`), DMARC's of the From header
 * (`header.from`). A pass vouches only for that domain: SPF and DKIM may
 * pass for any domain the sender owns, while DMARC's is reported only
 * when `from` is the message's one From mailbox at the domain it judged
 * (`dmarcOfFrom` in inbound-email.ts), so a DMARC pass means `from`'s
 * domain is verified; which address at it may send stays the domain's
 * own policy. Null when Email Routing's own ARC set
 * (authentication-results.ts) records none, or none core can trust, and
 * DMARC's also when its verdict isn't of `from` (several From headers or
 * mailboxes, none readable, another domain, or an address with several
 * `@` or cut to fit).
 */
const methodResult = v
  .object({
    result: v.enum([
      "pass",
      "fail",
      "softfail",
      "neutral",
      "none",
      "temperror",
      "permerror",
      "policy",
    ]),
    domain: v.string().nullable(),
  })
  .nullable();

/**
 * A reply as a run's inbox takes it: the message as an email trigger's run
 * gets it (`InboundEmail` in @grasp-os/shared/workflows, fitted to an
 * event's data), and what SPF, DKIM and DMARC said of it, each of which
 * domain. `from` is what its header says, its domain verified only by
 * DMARC's `pass`: the workflow checks who replied, never core, which takes
 * every reply. An
 * event contract's `email` type takes exactly this
 * (workflow-catalog.ts), so every reply fits whichever contract a binding
 * pins.
 */
export const emailReplyData = JSON.stringify(
  v.object({
    id: v.string(),
    stored: v.string().nullable(),
    from: mailbox,
    to: v.array(mailbox),
    cc: v.array(mailbox),
    subject: v.string(),
    date: v.string().nullable(),
    text: v.string(),
    truncated: v.boolean(),
    attachments: v.array(
      v.object({
        filename: v.string().nullable(),
        mimeType: v.string(),
        size: v.number().integer(),
        file: v.object({ id: v.string() }).optional(),
      })
    ),
    authentication: v.object({
      spf: methodResult,
      dkim: methodResult,
      dmarc: methodResult,
    }),
  }).descriptor
);

/** The contracts this release ships, by key. */
export const releaseContracts: readonly CatalogContractDefinition[] = [
  { key: modelStepContract, kind: "model" },
  {
    key: approvalContract,
    kind: "decision",
    input: JSON.stringify(v.record(jsonUpTo(approvalInputDepth)).descriptor),
    // What the decision page answers with: nothing, or the person's
    // comment (`takesPageAnswers`).
    response: JSON.stringify(
      v.union(v.null(), v.object({ comment: v.string() })).descriptor
    ),
  },
  {
    key: emailReplyContract,
    kind: "event",
    events: {
      [emailReplyType]: {
        data: emailReplyData,
        browser: false,
        ingress: "email",
      },
    },
  },
  { key: httpReadContract, kind: "connector", operations: { get: httpGet } },
  {
    key: httpContract,
    kind: "connector",
    operations: {
      get: httpGet,
      send: {
        input: enveloped(httpActionSchemas.send.input),
        output: enveloped(httpActionSchemas.send.output),
        readOnly: false,
      },
    },
  },
];

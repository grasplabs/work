import type { AgreementView } from "@grasp-os/shared/admin/admin-account";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import type { Agreed } from "@grasp-os/shared/admin/onboarding-admin";
import { present } from "@grasp-os/shared/admin/present";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
/**
 * An organization's Contract, ported from the prototype (grasplabs/prototype
 * `components/admin/org-contract.tsx`): the seats taken, the proposal, the
 * agreements that have to be in place before anyone is interviewed, and
 * billing. Read-only: the admin keeps nothing of its own on a company.
 * The agreements are core's own. Core holds no contract's terms, so the
 * page shows none.
 *
 * Billing is Stripe's (src/billing/billing.ts): how the company pays, what
 * is open or overdue, what it paid last and when the next invoice comes,
 * and its invoices as Stripe has them, once someone at Grasp linked it to
 * its customer there; until then, or without Stripe's key, it says so.
 *
 * The proposal is Rooms' (src/proposal/proposal.ts): the room Grasp wrote
 * it in and who signed it, once someone at Grasp linked the company to
 * its room there; until then, or without Rooms' token, it says so.
 */
import { Stat } from "@grasp-os/ui/components/stat";
import { cn } from "@grasp-os/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useOrganization } from "../../../admin/organization.tsx";
import { RoomsLink } from "../../../admin/rooms-link.tsx";
import { Section } from "../../../admin/section.tsx";
import { StripeLink } from "../../../admin/stripe-link.tsx";
import {
  addSecretStep,
  formatDate,
  formatList,
  money,
} from "../../../admin/words.ts";
import type {
  Billing,
  BillingAccount,
  BillingInvoice,
  Money,
} from "../../../billing/billing.ts";
import type { StripeReadError } from "../../../billing/stripe.ts";
import type {
  Proposal,
  ProposalRoom,
  ProposalSignature,
} from "../../../proposal/proposal.ts";
import type { RoomsReadError } from "../../../proposal/rooms.ts";

/** One for one, many for the rest. */
const plural = (count: number, one: string, other: string): string =>
  count === 1 ? one : other;

/** What an outside system hasn't brought yet: one line, as the prototype says it for every source. */
const notConnected = (name: string, secret: string): string =>
  `Once ${name} is connected, this fills in by itself. ${addSecretStep(secret)}`;

/** Each agreement by name. */
const agreementWords: Record<keyof Agreed, string> = {
  processing: "Agreement on handling data",
  assessment: "The company’s look at the risks to its people",
  council: "Works council",
};

/** Who else handles the company's data for Grasp, and what for. */
const others = [
  { name: "Anthropic", what: "The model that reads, talks and writes." },
  { name: "ElevenLabs", what: "Stephen’s voice." },
  { name: "OpenAI", what: "Writing out what people say, and reading PDFs." },
  { name: "Cloudflare", what: "Where Grasp runs." },
  { name: "Stripe", what: "Invoices and payments." },
] as const;

/** One figure: what it is, its value, and a line under it, orange when it needs someone. */
const Figure = ({
  label,
  value,
  sub,
  attention = false,
}: {
  label: string;
  value: string;
  sub: string;
  attention?: boolean;
}) => (
  <div className="bg-card flex flex-col gap-0.5 px-4 py-4 sm:px-5">
    <span className="text-muted-foreground text-xs">{label}</span>
    <Stat>{value}</Stat>
    <span
      className={cn(
        "text-xs",
        attention ? "text-status-attention" : "text-muted-foreground"
      )}
    >
      {sub}
    </span>
  </div>
);

/** One line of a part: what it is on the left, how it stands on the right. */
const Line = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-5 py-3">
    <dt className="text-muted-foreground">{label}</dt>
    {/* Beside its label however long it is, rather than on a line of its own pushed to the right. */}
    <dd className="min-w-0 flex-1 text-right">{children}</dd>
  </div>
);

/** Something in place. */
const Done = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground flex items-center gap-1.5">
    <CheckIcon aria-hidden className="text-status-agreed size-4 flex-none" />
    {children}
  </span>
);

/** The seats taken in the company's Grasp. */
const Summary = ({ view }: { view: AdminView }) => (
  <section
    aria-label="The contract in short"
    className="overflow-hidden rounded-xl border"
  >
    <Figure label="Seats" sub="are taken" value={String(view.seats.used)} />
  </section>
);

/** Why Rooms wasn't read now, as the rest of a sentence. */
const roomsUnreadWords: Record<RoomsReadError, string> = {
  refused: "Rooms turned the admin’s token away",
  not_found: "Rooms has no such room",
  invalid_answer: "what Rooms answered can’t be read",
  timeout: "Rooms didn’t answer in time",
  no_answer: "the request to Rooms failed",
};

/** The signature the proposal was signed with last, if any. */
const lastSigned = (room: ProposalRoom): ProposalSignature | undefined =>
  room.signatures.find((signature) => signature.status === "signed");

/** The proposal in a line: where it stands, or why it isn't known. */
const proposalLine = (proposal: Proposal): string => {
  switch (proposal.state) {
    case "not_connected": {
      return notConnected("Rooms", "ROOMS_READ_TOKEN");
    }
    case "not_linked": {
      return "Not linked to its room in Rooms yet. Link it by the room’s id, and this fills in by itself.";
    }
    case "unread": {
      return `Rooms can’t be read for it now: ${roomsUnreadWords[proposal.error]}.`;
    }
    case "read": {
      const signed = lastSigned(proposal.room);
      if (signed?.signed !== null && signed !== undefined) {
        return `Signed by ${signed.signer} on ${formatDate(signed.signed)}.`;
      }
      return proposal.room.signatures.some(
        (signature) => signature.status === "pending"
      )
        ? "Sent to sign, not signed yet."
        : "Not sent to sign yet.";
    }
    default: {
      return proposal satisfies never;
    }
  }
};

/** How one agreement stands, as the prototype says it. */
const Stands = ({ agreement }: { agreement: AgreementView }) => {
  const on = present(agreement.on) ? formatDate(agreement.on) : "";
  const by = agreement.by ?? "";
  if (agreement.state === "signed") {
    const council = agreement.what === "council";
    let line = council ? "Said yes" : "In place";
    if (on !== "" && by === "") {
      line = council ? `Said yes on ${on}` : `In place since ${on}`;
    } else if (on !== "") {
      line = council
        ? `Said yes on ${on}, through ${by}`
        : `Signed on ${on}, by ${by}`;
    }
    return <Done>{line}</Done>;
  }
  if (agreement.state === "none") {
    return <span className="text-muted-foreground">No works council</span>;
  }
  return (
    <span className="text-status-attention">
      {agreement.state === "waiting" ? "Still deciding" : "Not signed yet"}
    </span>
  );
};

/** The agreements that have to be in place before anyone is invited, and who else handles the data. */
const Agreements = ({
  view,
  recorded,
}: {
  view: AdminView;
  recorded: boolean;
}) => {
  const open = view.agreements.filter(
    (agreement) => agreement.state === "open" || agreement.state === "waiting"
  ).length;
  let description = "All three are in place.";
  if (!recorded) {
    description =
      "Nothing is recorded of them yet. Without all three, nobody is invited.";
  } else if (view.told) {
    description = "The team is told, so these stay as they were agreed.";
  } else if (open > 0) {
    description = `Without all three, nobody is invited. ${open} ${plural(open, "is", "are")} still open.`;
  }
  return (
    <Section
      description={description}
      id="contract-agreements"
      title="Agreed before the first interview"
    >
      <ul className="flex flex-col">
        {view.agreements.map((agreement) => {
          const paper = [
            present(agreement.version)
              ? `Version ${agreement.version} of Grasp’s own text`
              : "",
            agreement.file ?? "",
          ].filter((part) => part !== "");
          return (
            <li
              className="flex flex-col gap-0.5 border-t px-5 py-3"
              key={agreement.what}
            >
              <span>{agreementWords[agreement.what]}</span>
              <span className="text-xs">
                {recorded ? (
                  <Stands agreement={agreement} />
                ) : (
                  <span className="text-status-attention">
                    Not recorded yet
                  </span>
                )}
              </span>
              {paper.length > 0 ? (
                <span className="text-muted-foreground truncate text-xs">
                  {paper.join(" · ")}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="border-t">
        <Collapsible>
          <CollapsibleTrigger
            render={<Button className="mx-3 my-2" size="sm" variant="ghost" />}
          >
            Who else handles the data
            <ChevronDownIcon
              className="transition-transform in-data-panel-open:rotate-180"
              data-icon="inline-end"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="grid gap-x-8 gap-y-2 px-5 pb-4 sm:grid-cols-2">
              {others.map((other) => (
                <li className="flex flex-col" key={other.name}>
                  <span>{other.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {other.what}
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Section>
  );
};

/** Amounts in one or more currencies, in a phrase. */
const moneyOf = (amounts: readonly Money[]): string =>
  formatList(amounts.map(({ amount, currency }) => money(amount, currency)));

/** Why Stripe wasn't read now, as the rest of a sentence. */
const unreadWords: Record<StripeReadError, string> = {
  refused: "Stripe turned the admin’s key away",
  not_found: "Stripe has no such customer",
  tool_error: "Stripe answered with an error",
  invalid_answer: "what Stripe answered can’t be read",
  timeout: "Stripe didn’t answer in time",
  no_answer: "the request to Stripe failed",
};

/** What Billing says in a line under its title. */
const billingLine = (billing: Billing): string => {
  switch (billing.state) {
    case "not_connected": {
      return notConnected("Stripe", "STRIPE_RESTRICTED_KEY");
    }
    case "not_linked": {
      return "Not linked to its customer in Stripe yet. Link it by the customer’s id, and this fills in by itself.";
    }
    case "unread": {
      return `Stripe can’t be read for it now: ${unreadWords[billing.error]}.`;
    }
    case "read": {
      const { open, overdue } = billing.account;
      if (overdue.count > 0) {
        return `${overdue.count} ${plural(overdue.count, "invoice is", "invoices are")} overdue, ${moneyOf(overdue.amount)} in all.`;
      }
      if (open.count > 0) {
        return `${moneyOf(open.amount)} is still to be paid, none of it overdue.`;
      }
      return "Everything billed is paid.";
    }
    default: {
      return billing satisfies never;
    }
  }
};

/** How the company pays, in a few words. */
const paysWords = (pays: BillingAccount["pays"]): string => {
  if (pays === null) {
    return "Not known yet";
  }
  if (pays.by === "charge") {
    return "Stripe charges it each time";
  }
  return pays.daysToPay === null
    ? "It is sent each invoice to pay"
    : `It is sent each invoice, to pay within ${pays.daysToPay} ${plural(pays.daysToPay, "day", "days")}`;
};

/** When the next invoice comes, or that none does. */
const nextWords = (subscription: BillingAccount["subscription"]): string => {
  if (subscription === null) {
    return "None: no subscription runs";
  }
  if (subscription.next !== null) {
    const { on, amount } = subscription.next;
    return amount === null
      ? formatDate(on)
      : `${money(amount.amount, amount.currency)} on ${formatDate(on)}, before tax`;
  }
  return subscription.ends === null
    ? `None: the subscription is ${subscription.status.replaceAll("_", " ")}`
    : `None: the subscription ends on ${formatDate(subscription.ends)}`;
};

/** What Stripe says of the company, line by line. */
const BillingLines = ({
  account,
  customerId,
}: {
  account: BillingAccount;
  customerId: string;
}) => (
  <dl>
    <Line label="Customer in Stripe">
      <a
        className="hover:text-foreground underline underline-offset-4"
        href={account.url}
        rel="noreferrer"
        target="_blank"
      >
        {account.name ?? customerId}
      </a>
    </Line>
    <Line label="How it pays">{paysWords(account.pays)}</Line>
    <Line label="Open">
      {account.open.count === 0
        ? "Nothing"
        : `${moneyOf(account.open.amount)}, ${account.open.count} ${plural(account.open.count, "invoice", "invoices")}`}
    </Line>
    <Line label="Overdue">
      {account.overdue.count === 0 || account.overdue.since === null ? (
        "Nothing"
      ) : (
        <span className="text-status-attention">
          {`${moneyOf(account.overdue.amount)}, due since ${formatDate(account.overdue.since)}`}
        </span>
      )}
    </Line>
    <Line label="Last paid">
      {account.lastPaid === null
        ? "Nothing yet"
        : `${money(account.lastPaid.amount.amount, account.lastPaid.amount.currency)} on ${formatDate(account.lastPaid.on)}`}
    </Line>
    <Line label="Next invoice">{nextWords(account.subscription)}</Line>
  </dl>
);

/** Each status of a signature request, in a word. */
const signatureWords: Record<ProposalSignature["status"], string> = {
  signed: "Signed",
  pending: "Waiting",
  revoked: "Withdrawn",
  expired: "Expired",
};

/**
 * The proposal: the room in Rooms the company was sent, who was asked to
 * sign it and who did, and the room it is linked to, which staff link or
 * change here.
 */
const ProposalPart = ({
  proposal,
  clientId,
}: {
  proposal: Proposal;
  clientId: string;
}) => {
  const projectId = proposal.state === "not_linked" ? null : proposal.projectId;
  return (
    <Section
      description={proposalLine(proposal)}
      id="contract-proposal"
      title="The proposal"
    >
      {proposal.state === "read" ? (
        <dl>
          <Line label="Room in Rooms">
            <a
              className="hover:text-foreground underline underline-offset-4"
              href={proposal.room.url}
              rel="noreferrer"
              target="_blank"
            >
              {proposal.room.name}
            </a>
          </Line>
          <Line label="For">{proposal.room.clientName || "Nobody named"}</Line>
          <Line label="Last changed">
            {proposal.room.archived
              ? `${formatDate(proposal.room.updated)}, archived since`
              : formatDate(proposal.room.updated)}
          </Line>
        </dl>
      ) : null}
      {proposal.state === "read" && proposal.room.signatures.length > 0 ? (
        <ul className="flex flex-col">
          {proposal.room.signatures.map((signature) => (
            <li
              className="flex items-baseline justify-between gap-x-6 border-t px-5 py-2.5"
              key={`${signature.email}-${signature.sent}-${signature.status}`}
            >
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                <span className="truncate">{signature.signer}</span>
                <span className="text-muted-foreground text-xs">
                  {signature.signed === null
                    ? `Sent ${formatDate(signature.sent)}`
                    : `Signed ${formatDate(signature.signed)}`}
                </span>
              </span>
              <span
                className={cn(
                  "w-20 text-right text-xs",
                  signature.status === "pending"
                    ? "text-status-attention"
                    : "text-muted-foreground"
                )}
              >
                {signatureWords[signature.status]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <RoomsLink clientId={clientId} projectId={projectId} />
    </Section>
  );
};

/**
 * Billing: what Stripe says the company pays and whether it is paid, and
 * the customer it is linked to there, which staff link or change here.
 */
const BillingPart = ({
  billing,
  clientId,
}: {
  billing: Billing;
  clientId: string;
}) => {
  const customerId = billing.state === "not_linked" ? null : billing.customerId;
  return (
    <Section
      description={billingLine(billing)}
      id="contract-billing"
      title="Billing"
    >
      {billing.state === "read" ? (
        <BillingLines
          account={billing.account}
          customerId={billing.customerId}
        />
      ) : null}
      <StripeLink clientId={clientId} customerId={customerId} />
    </Section>
  );
};

/** Each status of an invoice in Stripe, in a word. */
const invoiceStatusWords: Record<BillingInvoice["status"], string> = {
  paid: "Paid",
  open: "Due",
  overdue: "Overdue",
  void: "Void",
  uncollectible: "Written off",
  draft: "Draft",
};

/** The invoices as Stripe has them, the newest first. */
const StripeInvoices = ({ account }: { account: BillingAccount }) => {
  const { invoices, open } = account;
  let description = "None yet in Stripe.";
  if (invoices.length > 0) {
    description =
      open.count > 0
        ? `From Stripe, the latest ${invoices.length}. ${open.count} ${plural(open.count, "is", "are")} still to be paid.`
        : `From Stripe, the latest ${invoices.length}. All are paid.`;
  }
  return (
    <Section description={description} id="contract-invoices" title="Invoices">
      {invoices.length > 0 ? (
        <ul className="flex flex-col">
          {invoices.map((invoice) => (
            <li
              className="flex items-baseline justify-between gap-x-6 border-t px-5 py-2.5"
              key={invoice.number}
            >
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                <span className="tabular-nums">{invoice.number}</span>
                <span className="text-muted-foreground text-xs">
                  {formatDate(invoice.date)}
                </span>
              </span>
              <span className="flex items-baseline gap-x-6">
                <span className="tabular-nums">
                  {money(invoice.amount, invoice.currency)}
                </span>
                <span
                  className={cn(
                    "w-20 text-right text-xs",
                    invoice.status === "open" || invoice.status === "overdue"
                      ? "text-status-attention"
                      : "text-muted-foreground"
                  )}
                >
                  {invoiceStatusWords[invoice.status]}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
};

const Contract = () => {
  const { admin, view } = useOrganization();
  // Until staff say where the agreements stand, core holds none, and the model's "no works council" is only its default.
  const recorded = admin.snapshot.agreements !== null;
  const { billing, proposal } = admin;
  return (
    <>
      <Summary view={view} />
      <ProposalPart clientId={admin.client.id} proposal={proposal} />
      <Agreements recorded={recorded} view={view} />
      <BillingPart billing={billing} clientId={admin.client.id} />
      {billing.state === "read" ? (
        <StripeInvoices account={billing.account} />
      ) : null}
    </>
  );
};

/** An organization's Contract: the seats, the proposal, the agreements and billing. */
export const Route = createFileRoute("/organizations/$clientId/contract")({
  component: Contract,
});

/**
 * An organization's Contract, a tab of its Details, set on the page as
 * Grasp Work sets one: the agreements that have to be in place before
 * anyone is interviewed, which staff change here until the team is told
 * (agreements.tsx), and billing. The agreements are core's own. Core
 * holds no contract's terms, so the tab shows none; the seats taken stand
 * with the members.
 *
 * Billing is Stripe's (src/billing/billing.ts): what is open or overdue,
 * what it paid last and when the next invoice comes as figures, how the
 * company pays, and its invoices as Stripe has them, once someone at
 * Grasp linked it to its customer there; until then, or without Stripe's
 * key, it says so.
 */
import type { AgreementView } from "@grasp-os/shared/admin/admin-account";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import type { Agreed } from "@grasp-os/shared/admin/onboarding-admin";
import { present } from "@grasp-os/shared/admin/present";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Link } from "@grasp-os/ui/components/link";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type {
  Billing,
  BillingAccount,
  BillingInvoice,
  Money,
} from "../billing/billing.ts";
import type { StripeReadError } from "../billing/stripe.ts";
import { AgreementsAction } from "./agreements.tsx";
import { useOrganization } from "./organization.tsx";
import { StripeLink } from "./stripe-link.tsx";
import { addSecretStep, formatDate, formatList, money } from "./words.ts";

const styles = stylex.create({
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  part: { display: "flex", flexDirection: "column", gap: space["6"] },
});

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
  { name: "Mistral", what: "Stephen’s voice." },
  { name: "OpenAI", what: "Writing out what people say, and reading PDFs." },
  { name: "Cloudflare", what: "Where Grasp runs." },
  { name: "Stripe", what: "Invoices and payments." },
] as const;

/** How one agreement stands, in a line, and as a mark: green once in place, amber while open. */
const standsOf = (
  agreement: AgreementView
): { line: string; mark: string; tone: BadgeVariant } => {
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
    return { line, mark: council ? "Said yes" : "In place", tone: "success" };
  }
  if (agreement.state === "none") {
    return { line: "No works council", mark: "None", tone: "default" };
  }
  const line =
    agreement.state === "waiting" ? "Still deciding" : "Not signed yet";
  return { line, mark: line, tone: "warning" };
};

/** The agreements that have to be in place before anyone is invited, and who else handles the data. */
const Agreements = ({
  view,
  recorded,
  action,
}: {
  view: AdminView;
  recorded: boolean;
  /** Changing what was agreed. */
  action: ReactNode;
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
    <Part aria-labelledby="contract-agreements">
      <SectionHeader
        actions={action}
        description={description}
        id="contract-agreements"
        size="sm"
        title="Agreed before the first interview"
        variant="group"
      />
      <div {...stylex.props(styles.part)}>
        <ItemGroup aria-labelledby="contract-agreements" separated>
          {view.agreements.map((agreement) => {
            const stands = recorded
              ? standsOf(agreement)
              : {
                  line: "Not recorded yet",
                  mark: "Not recorded yet",
                  tone: "warning" as const,
                };
            const paper = [
              // Said once: in the mark alone when the line says no more.
              stands.line === stands.mark ? "" : stands.line,
              present(agreement.version)
                ? `Version ${agreement.version} of Grasp’s own text`
                : "",
              agreement.file ?? "",
            ].filter((part) => part !== "");
            return (
              <Item key={agreement.what}>
                <ItemContent>
                  <ItemTitle>{agreementWords[agreement.what]}</ItemTitle>
                  <ItemDescription>{paper.join(" · ")}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge dot variant={stands.tone}>
                    {stands.mark}
                  </Badge>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
        <Collapsible fitContent>
          <CollapsibleTrigger>Who else handles the data</CollapsibleTrigger>
          <CollapsibleContent asChild>
            <div>
              <KeyValueList
                divided
                items={others.map((other) => ({
                  id: other.name,
                  label: other.name,
                  value: other.what,
                }))}
                orientation="horizontal"
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Part>
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

/** The next invoice as a figure: what it comes to and when, or that none comes, and why. */
const nextFigure = (
  subscription: BillingAccount["subscription"]
): { value: string; change: string } => {
  if (subscription === null) {
    return { value: "None", change: "No subscription runs" };
  }
  if (subscription.next !== null) {
    const { on, amount } = subscription.next;
    return amount === null
      ? { value: formatDate(on), change: "Its amount isn’t known yet" }
      : {
          value: money(amount.amount, amount.currency),
          change: `On ${formatDate(on)}, before tax`,
        };
  }
  return {
    value: "None",
    change:
      subscription.ends === null
        ? `The subscription is ${subscription.status.replaceAll("_", " ")}`
        : `The subscription ends on ${formatDate(subscription.ends)}`,
  };
};

/** What Stripe says the company owes, paid and is billed next, as figures. */
const BillingFigures = ({ account }: { account: BillingAccount }) => {
  const { open, overdue, lastPaid, subscription } = account;
  return (
    <StatGroup aria-label="Its billing" columns={4}>
      <Stat
        change={
          open.count === 0
            ? "Nothing to pay"
            : `${open.count} ${plural(open.count, "invoice", "invoices")}`
        }
        label="Open"
        value={open.count === 0 ? "Nothing" : moneyOf(open.amount)}
      />
      <Stat
        change={
          overdue.count === 0 || overdue.since === null
            ? "None"
            : `Due since ${formatDate(overdue.since)}`
        }
        label="Overdue"
        value={overdue.count === 0 ? "Nothing" : moneyOf(overdue.amount)}
        variant={overdue.count === 0 ? "default" : "warning"}
      />
      <Stat
        change={lastPaid === null ? "Nothing yet" : formatDate(lastPaid.on)}
        label="Last paid"
        value={
          lastPaid === null
            ? "Nothing"
            : money(lastPaid.amount.amount, lastPaid.amount.currency)
        }
      />
      <Stat label="Next invoice" {...nextFigure(subscription)} />
    </StatGroup>
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
    <Part aria-labelledby="contract-billing">
      <SectionHeader
        description={billingLine(billing)}
        id="contract-billing"
        size="sm"
        title="Billing"
        variant="group"
      />
      <div {...stylex.props(styles.part)}>
        {billing.state === "read" ? (
          <>
            <BillingFigures account={billing.account} />
            <KeyValueList
              divided
              items={[
                {
                  id: "customer",
                  label: "Customer in Stripe",
                  value: (
                    <Link external href={billing.account.url}>
                      {billing.account.name ?? billing.customerId}
                    </Link>
                  ),
                },
                {
                  id: "pays",
                  label: "How it pays",
                  value: paysWords(billing.account.pays),
                },
              ]}
              orientation="horizontal"
            />
          </>
        ) : null}
        <StripeLink clientId={clientId} customerId={customerId} />
      </div>
    </Part>
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

/** How an invoice stands, as its mark: amber while it is to be paid. */
const invoiceTones: Record<BillingInvoice["status"], BadgeVariant> = {
  paid: "success",
  open: "warning",
  overdue: "warning",
  void: "default",
  uncollectible: "default",
  draft: "outline",
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
    <Part aria-labelledby="contract-invoices">
      <SectionHeader
        description={description}
        id="contract-invoices"
        size="sm"
        title="Invoices"
        variant="group"
      />
      {invoices.length > 0 ? (
        <ItemGroup aria-labelledby="contract-invoices" separated>
          {invoices.map((invoice) => (
            <Item key={invoice.number} size="sm">
              <ItemContent>
                <ItemTitle>{invoice.number}</ItemTitle>
                <ItemDescription>
                  {`${formatDate(invoice.date)} · ${money(invoice.amount, invoice.currency)}`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant={invoiceTones[invoice.status]}>
                  {invoiceStatusWords[invoice.status]}
                </Badge>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : null}
    </Part>
  );
};

/** An organization's Contract: the agreements and billing. */
export const OrgContract = () => {
  const { admin, view } = useOrganization();
  // Until staff say where the agreements stand, core holds none, and the model's "no works council" is only its default.
  const recorded = admin.snapshot.agreements !== null;
  const { billing } = admin;
  return (
    <div {...stylex.props(styles.parts)}>
      <Agreements
        action={
          <AgreementsAction
            agreements={admin.snapshot.agreements}
            clientId={admin.client.id}
            told={view.told}
          />
        }
        recorded={recorded}
        view={view}
      />
      <BillingPart billing={billing} clientId={admin.client.id} />
      {billing.state === "read" ? (
        <StripeInvoices account={billing.account} />
      ) : null}
    </div>
  );
};

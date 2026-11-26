/**
 * An organization's Contract, ported from the prototype (grasplabs/prototype
 * `components/admin/org-contract.tsx`), a tab of its Details: the
 * agreements that have to be in place before anyone is interviewed, which
 * staff change here until the team is told (agreements.tsx), and billing.
 * The agreements are core's own. Core holds no contract's terms, so the
 * tab shows none; the seats taken stand with the members.
 *
 * Billing is Stripe's (src/billing/billing.ts): how the company pays, what
 * is open or overdue, what it paid last and when the next invoice comes,
 * and its invoices as Stripe has them, once someone at Grasp linked it to
 * its customer there; until then, or without Stripe's key, it says so.
 */
import type { AgreementView } from "@grasp-os/shared/admin/admin-account";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import type { Agreed } from "@grasp-os/shared/admin/onboarding-admin";
import { present } from "@grasp-os/shared/admin/present";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Link } from "@grasp-os/ui/components/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
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
import { Panel } from "./panel.tsx";
import { StripeLink } from "./stripe-link.tsx";
import { addSecretStep, formatDate, formatList, money } from "./words.ts";

const styles = stylex.create({
  // Something in place: a check in the success colour before quiet words.
  done: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    color: colors.mutedForeground,
  },
  check: { display: "inline-flex", color: colors.success },
  muted: { color: colors.mutedForeground },
  // What needs someone: in the warning's colour.
  warning: { color: colors.warning },
  stands: { display: "flex", flexDirection: "column", gap: space["1"] },
  // Who else handles the data, two abreast where there is room.
  others: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
    columnGap: space["8"],
    rowGap: space["2"],
    margin: 0,
    padding: 0,
    listStyle: "none",
    paddingBlockStart: space["2"],
  },
  other: { display: "flex", flexDirection: "column" },
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

/** Something in place. */
const Done = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.done)}>
    <span {...stylex.props(styles.check)}>
      <Icon icon={CheckIcon} />
    </span>
    {children}
  </span>
);

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
    return <span {...stylex.props(styles.muted)}>No works council</span>;
  }
  return (
    <span {...stylex.props(styles.warning)}>
      {agreement.state === "waiting" ? "Still deciding" : "Not signed yet"}
    </span>
  );
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
    <Panel
      action={action}
      description={description}
      id="contract-agreements"
      title="Agreed before the first interview"
    >
      <CardContent flush>
        <ItemGroup separated>
          {view.agreements.map((agreement) => {
            const paper = [
              present(agreement.version)
                ? `Version ${agreement.version} of Grasp’s own text`
                : "",
              agreement.file ?? "",
            ].filter((part) => part !== "");
            return (
              <Item key={agreement.what} size="sm">
                <ItemContent>
                  <ItemTitle>{agreementWords[agreement.what]}</ItemTitle>
                  <ItemDescription>
                    <span {...stylex.props(styles.stands)}>
                      {recorded ? (
                        <Stands agreement={agreement} />
                      ) : (
                        <span {...stylex.props(styles.warning)}>
                          Not recorded yet
                        </span>
                      )}
                      {paper.length > 0 ? (
                        <span>{paper.join(" · ")}</span>
                      ) : null}
                    </span>
                  </ItemDescription>
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
      </CardContent>
      <CardContent>
        <Collapsible fitContent variant="outline">
          <CollapsibleTrigger>Who else handles the data</CollapsibleTrigger>
          <CollapsibleContent>
            <ul {...stylex.props(styles.others)}>
              {others.map((other) => (
                <li key={other.name} {...stylex.props(styles.other)}>
                  <span>{other.name}</span>
                  <Text as="span" color="muted" size="xs">
                    {other.what}
                  </Text>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Panel>
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
  <CardContent>
    <KeyValueList
      divided
      items={[
        {
          id: "customer",
          label: "Customer in Stripe",
          value: (
            <Link external href={account.url}>
              {account.name ?? customerId}
            </Link>
          ),
        },
        { id: "pays", label: "How it pays", value: paysWords(account.pays) },
        {
          id: "open",
          label: "Open",
          value:
            account.open.count === 0
              ? "Nothing"
              : `${moneyOf(account.open.amount)}, ${account.open.count} ${plural(account.open.count, "invoice", "invoices")}`,
        },
        {
          id: "overdue",
          label: "Overdue",
          value:
            account.overdue.count === 0 || account.overdue.since === null ? (
              "Nothing"
            ) : (
              <span {...stylex.props(styles.warning)}>
                {`${moneyOf(account.overdue.amount)}, due since ${formatDate(account.overdue.since)}`}
              </span>
            ),
        },
        {
          id: "paid",
          label: "Last paid",
          value:
            account.lastPaid === null
              ? "Nothing yet"
              : `${money(account.lastPaid.amount.amount, account.lastPaid.amount.currency)} on ${formatDate(account.lastPaid.on)}`,
        },
        {
          id: "next",
          label: "Next invoice",
          value: nextWords(account.subscription),
        },
      ]}
      orientation="horizontal"
    />
  </CardContent>
);

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
    <Panel
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
    </Panel>
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
    <Panel description={description} id="contract-invoices" title="Invoices">
      {invoices.length > 0 ? (
        <CardContent flush>
          <Table aria-label="Invoices">
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead align="end">Amount</TableHead>
                <TableHead align="end">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.number}>
                  <TableCell rowHeader>{invoice.number}</TableCell>
                  <TableCell>{formatDate(invoice.date)}</TableCell>
                  <TableCell align="end">
                    {money(invoice.amount, invoice.currency)}
                  </TableCell>
                  <TableCell align="end">
                    <span
                      {...stylex.props(
                        invoice.status === "open" ||
                          invoice.status === "overdue"
                          ? styles.warning
                          : styles.muted
                      )}
                    >
                      {invoiceStatusWords[invoice.status]}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      ) : null}
    </Panel>
  );
};

/** An organization's Contract: the agreements and billing. */
export const OrgContract = () => {
  const { admin, view } = useOrganization();
  // Until staff say where the agreements stand, core holds none, and the model's "no works council" is only its default.
  const recorded = admin.snapshot.agreements !== null;
  const { billing } = admin;
  return (
    <>
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
    </>
  );
};

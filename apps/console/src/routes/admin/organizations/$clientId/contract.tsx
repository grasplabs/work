/**
 * An organization's Contract, ported from the prototype (grasplabs/prototype
 * `components/admin/org-contract.tsx`): where the contract stands and the
 * seats taken, its terms, what it gives the company, the agreements that
 * have to be in place before anyone is interviewed, and the invoices it
 * brought. Read-only: the console keeps nothing of its own on a company,
 * so the prototype's fields and switches are what they say.
 *
 * Core holds no contract yet, so the model reads it as unknown: the page
 * says nothing is known about it, instead of a draft, dates or fees. The
 * agreements are core's own.
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
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { cn } from "@grasp-os/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, FileTextIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useOrganization } from "../../../../admin/organization.tsx";
import { StripeLink } from "../../../../admin/stripe-link.tsx";
import {
  contractWords,
  euros,
  formatDate,
  formatList,
  money,
} from "../../../../admin/words.ts";
import type {
  Billing,
  BillingAccount,
  BillingInvoice,
  Money,
} from "../../../../billing/billing.ts";
import type { StripeReadError } from "../../../../billing/stripe.ts";

/** An invoice's amount, always to the cent. */
const cents = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** One for one, many for the rest. */
const plural = (count: number, one: string, other: string): string =>
  count === 1 ? one : other;

/** What an outside system hasn't brought yet: one line, as the prototype says it for every source. */
const notConnected = (name: string): string =>
  `Once ${name} is connected, this fills in by itself.`;

/** Each agreement by name. */
const agreementWords: Record<keyof Agreed, string> = {
  processing: "Agreement on handling data",
  assessment: "The company’s look at the risks to its people",
  council: "Works council",
};

/** Who else handles the company's data for Grasp, and what for. */
const others = [
  { name: "Anthropic", what: "The model that reads, talks and writes." },
  {
    name: "ElevenLabs",
    what: "Stephen’s voice, and writing out what people say.",
  },
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
    <span className="text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
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

/** A part of the page: its title, one line on it, and what is in it. */
const Part = ({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) => (
  <section
    aria-labelledby={id === undefined ? undefined : `${id}-title`}
    className="bg-card scroll-mt-4 overflow-hidden rounded-xl border"
    id={id}
  >
    <div className="flex flex-col gap-0.5 px-5 py-4">
      <h2
        className="font-medium"
        id={id === undefined ? undefined : `${id}-title`}
      >
        {title}
      </h2>
      <p className="text-muted-foreground">{description}</p>
    </div>
    {children}
  </section>
);

/** One line of a part: what it is on the left, how it stands on the right. */
const Line = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-5 py-3">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-right">{children}</dd>
  </div>
);

/** Something in place. */
const Done = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground flex items-center gap-1.5">
    <CheckIcon aria-hidden className="text-status-agreed size-4 flex-none" />
    {children}
  </span>
);

/** Where the contract stands, in a few words under its figure. */
const statusLine = ({ contract }: AdminView): string => {
  if (contract.status === "signed") {
    const on = present(contract.signed) ? formatDate(contract.signed) : "";
    return present(contract.signedBy)
      ? `on ${on}, by ${contract.signedBy}`
      : `on ${on}`;
  }
  if (contract.status === "sent" && present(contract.sent)) {
    return `sent on ${formatDate(contract.sent)}`;
  }
  return "not sent yet";
};

/** How long it runs, once it is more than a draft. */
const runsFigure = ({
  contract,
  asOf,
}: AdminView): {
  label: string;
  value: string;
  sub: string;
  attention: boolean;
} => {
  const from = formatDate(contract.from);
  const until = formatDate(contract.until);
  if (contract.daysLeft < 0) {
    return {
      label: "Ended",
      value: until,
      sub: "nothing runs now",
      attention: true,
    };
  }
  if (contract.from > asOf) {
    return {
      label: "Starts",
      value: from,
      sub: `until ${until}`,
      attention: false,
    };
  }
  let sub = `until ${until}`;
  if (contract.renews && present(contract.noticeBy)) {
    sub = `carries on, unless notice is given by ${formatDate(contract.noticeBy)}`;
  } else if (contract.ending) {
    sub = `until ${until}: nothing is agreed for after`;
  }
  return {
    label: "Still runs",
    value: `${contract.daysLeft} ${plural(contract.daysLeft, "day", "days")}`,
    sub,
    attention: contract.ending,
  };
};

/** The contract in short: where it stands, how long it runs, what it costs, and the seats taken. */
const Summary = ({ view }: { view: AdminView }) => {
  const { contract, seats } = view;
  const known = !view.unknown.contract;
  const draft = contract.status === "draft";
  const runs = runsFigure(view);
  let seatsSub = "are taken";
  if (!known) {
    seatsSub = "taken; the contract isn’t known yet";
  } else if (seats.of === 0) {
    seatsSub = "taken; the contract gives none yet";
  }
  return (
    <section
      aria-label="The contract in short"
      className="overflow-hidden rounded-xl border"
    >
      <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-4">
        {known ? (
          <Figure
            attention={contract.status !== "signed"}
            label="Contract"
            sub={statusLine(view)}
            value={contractWords[contract.status]}
          />
        ) : (
          <Figure
            label="Contract"
            sub="the company’s Grasp doesn’t hold it yet"
            value="Not known yet"
          />
        )}
        {draft || !known ? null : (
          <>
            <Figure
              attention={runs.attention}
              label={runs.label}
              sub={runs.sub}
              value={runs.value}
            />
            <Figure
              label="Fee a month"
              sub={
                contract.plan ? `${contract.plan}, before VAT` : "before VAT"
              }
              value={euros(contract.fee)}
            />
          </>
        )}
        <Figure
          attention={known && seats.of > 0 && seats.used > seats.of}
          label="Seats"
          sub={seatsSub}
          value={
            known && seats.of > 0
              ? `${seats.used} of ${seats.of}`
              : String(seats.used)
          }
        />
      </div>
    </section>
  );
};

/** The terms as they were signed; for a draft, that nothing is agreed yet. */
const Terms = ({ view }: { view: AdminView }) => {
  const { contract } = view;
  if (view.unknown.contract) {
    return (
      <Part
        description="Nothing is known about the contract yet."
        id="contract-contract"
        title="The terms"
      >
        <dl>
          <Line label="The proposal">{notConnected("Rooms")}</Line>
        </dl>
      </Part>
    );
  }
  if (contract.status === "draft") {
    return (
      <Part
        description="Nothing is agreed yet: the contract is still being written."
        id="contract-contract"
        title="The terms"
      >
        <dl>
          <Line label="The proposal">{notConnected("Rooms")}</Line>
        </dl>
      </Part>
    );
  }
  const after =
    contract.renews && present(contract.noticeBy)
      ? `Carries on by itself; the last day to give notice is ${formatDate(contract.noticeBy)}.`
      : "It ends on the last day, unless something new is agreed.";
  return (
    <Part
      description="As it was signed."
      id="contract-contract"
      title="The terms"
    >
      <dl>
        <Line label="Plan">{contract.plan || "None named"}</Line>
        <Line label="Fee a month">{`${euros(contract.fee)}, before VAT`}</Line>
        <Line label="Signed for the company by">
          {contract.signedBy ?? "Nobody yet"}
        </Line>
        <Line label="Runs from">{formatDate(contract.from)}</Line>
        <Line label="Runs until">{formatDate(contract.until)}</Line>
        <Line label="After that">{after}</Line>
        <Line label="The signed copy">
          {present(contract.file) ? (
            <span className="flex min-w-0 items-center gap-2">
              <FileTextIcon
                aria-hidden
                className="text-muted-foreground size-4 flex-none"
              />
              <span className="truncate">{contract.file}</span>
            </span>
          ) : (
            "No copy yet"
          )}
        </Line>
        <Line label="The proposal">{notConnected("Rooms")}</Line>
      </dl>
    </Part>
  );
};

/**
 * How many people may come in, beside the seats taken, and how much AI use
 * the fee covers. Not what was used: where core hasn't counted it, the
 * model only works it out.
 */
const Gives = ({ view }: { view: AdminView }) => {
  const { contract, seats } = view;
  let open = "";
  if (view.unknown.contract) {
    open = "Not known yet";
  } else if (contract.status === "draft") {
    open = "None agreed yet";
  }
  return (
    <Part
      description="How many people may come in, and how much AI use the fee covers."
      title="What it gives the company"
    >
      <dl>
        <Line label="Seats">
          {`${open === "" ? contract.seats : open}; ${seats.used} ${plural(seats.used, "is", "are")} taken.`}
        </Line>
        <Line label="AI use a month">
          {open === "" ? euros(contract.aiIncluded) : open}
        </Line>
      </dl>
    </Part>
  );
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
    <Part
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
    </Part>
  );
};

/** What the invoices come to so far, in a line. */
const invoicesLine = ({ contract, invoices, unknown }: AdminView): string => {
  if (unknown.contract) {
    return "None known yet: nothing is known about the contract.";
  }
  if (invoices.length === 0) {
    return contract.status === "signed"
      ? `None yet. The first one comes on ${formatDate(contract.from)}.`
      : "None yet. There is no signed contract.";
  }
  const due = invoices.filter((invoice) => invoice.status !== "paid").length;
  return due > 0
    ? `One a month, through Stripe. ${due} ${plural(due, "is", "are")} still to be paid.`
    : "One a month, through Stripe. All are paid.";
};

/** The invoices the contract brought so far, the newest first. */
const Invoices = ({ view }: { view: AdminView }) => (
  <Part
    description={invoicesLine(view)}
    id="contract-invoices"
    title="Invoices"
  >
    {view.invoices.length > 0 ? (
      <ul className="flex flex-col">
        {view.invoices.map((invoice) => (
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
                {cents.format(invoice.amount)}
              </span>
              <span
                className={cn(
                  "w-10 text-right text-xs",
                  invoice.status === "paid"
                    ? "text-muted-foreground"
                    : "text-status-attention"
                )}
              >
                {invoice.status === "paid" ? "Paid" : "Due"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    ) : null}
  </Part>
);

/** Amounts in one or more currencies, in a phrase. */
const moneyOf = (amounts: readonly Money[]): string =>
  formatList(amounts.map(({ amount, currency }) => money(amount, currency)));

/** Why Stripe wasn't read now, as the rest of a sentence. */
const unreadWords: Record<StripeReadError, string> = {
  refused: "Stripe turned the console’s key away",
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
      return notConnected("Stripe");
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
    <Part
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
    <Part description={description} id="contract-invoices" title="Invoices">
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
    </Part>
  );
};

const Contract = () => {
  const { admin, view } = useOrganization();
  // Until staff say where the agreements stand, core holds none, and the model's "no works council" is only its default.
  const recorded = admin.snapshot.agreements !== null;
  const { billing } = admin;
  return (
    <>
      <Summary view={view} />
      <Terms view={view} />
      <Gives view={view} />
      <Agreements recorded={recorded} view={view} />
      <BillingPart billing={billing} clientId={admin.client.id} />
      {billing.state === "read" ? (
        <StripeInvoices account={billing.account} />
      ) : (
        <Invoices view={view} />
      )}
    </>
  );
};

/** An organization's Contract: the contract, what it gives, the agreements and the invoices. */
export const Route = createFileRoute("/admin/organizations/$clientId/contract")(
  {
    component: Contract,
  }
);

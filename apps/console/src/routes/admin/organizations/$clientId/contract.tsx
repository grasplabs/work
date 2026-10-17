/**
 * An organization's Contract, ported from the prototype (grasplabs/prototype
 * `components/admin/org-contract.tsx`): where the contract stands and the
 * seats taken, its terms, what it gives the company, the agreements that
 * have to be in place before anyone is interviewed, and the invoices it
 * brought. Read-only: the console keeps nothing of its own on a company,
 * so the prototype's fields and switches are what they say.
 *
 * Core holds no contract yet, so the model has every contract as a draft:
 * nothing of its terms is agreed, and the page says so instead of the
 * model's placeholder dates and fees. The agreements are core's own.
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
import { contractWords, euros, formatDate } from "../../../../admin/words.ts";

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
  const draft = contract.status === "draft";
  const runs = runsFigure(view);
  return (
    <section
      aria-label="The contract in short"
      className="overflow-hidden rounded-xl border"
    >
      <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-4">
        <Figure
          attention={contract.status !== "signed"}
          label="Contract"
          sub={statusLine(view)}
          value={contractWords[contract.status]}
        />
        {draft ? null : (
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
          attention={seats.of > 0 && seats.used > seats.of}
          label="Seats"
          sub={
            seats.of > 0 ? "are taken" : "taken; the contract gives none yet"
          }
          value={
            seats.of > 0 ? `${seats.used} of ${seats.of}` : String(seats.used)
          }
        />
      </div>
    </section>
  );
};

/** The terms as they were signed; for a draft, that nothing is agreed yet. */
const Terms = ({ view }: { view: AdminView }) => {
  const { contract } = view;
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
  const draft = contract.status === "draft";
  return (
    <Part
      description="How many people may come in, and how much AI use the fee covers."
      title="What it gives the company"
    >
      <dl>
        <Line label="Seats">
          {`${draft ? "None agreed yet" : contract.seats}; ${seats.used} ${plural(seats.used, "is", "are")} taken.`}
        </Line>
        <Line label="AI use a month">
          {draft ? "None agreed yet" : euros(contract.aiIncluded)}
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
const invoicesLine = ({ contract, invoices }: AdminView): string => {
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

const Contract = () => {
  const { admin, view } = useOrganization();
  // Until staff say where the agreements stand, core holds none, and the model's "no works council" is only its default.
  const recorded = admin.snapshot.agreements !== null;
  return (
    <>
      <Summary view={view} />
      <Terms view={view} />
      <Gives view={view} />
      <Agreements recorded={recorded} view={view} />
      <Invoices view={view} />
    </>
  );
};

/** An organization's Contract: the contract, what it gives, the agreements and the invoices. */
export const Route = createFileRoute("/admin/organizations/$clientId/contract")(
  {
    component: Contract,
  }
);

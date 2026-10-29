import { CONTACT_ROLES } from "@grasp-os/shared/admin/onboarding-admin";
import type { ContactRole } from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLinkIcon, MailIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AttioLink } from "../../../admin/attio-link.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { sourceNames } from "../../../admin/sections.ts";
import { formatDate, formatList, money } from "../../../admin/words.ts";
import type { AttioReadError } from "../../../crm/attio.ts";
import type { Crm, CrmDeal, CrmRecords } from "../../../crm/crm.ts";

/**
 * An organization's Details, as the prototype has them
 * (grasplabs/prototype `components/admin/org-details.tsx` and the Attio
 * panel of `source-panels.tsx`): the company itself, who Grasp deals with
 * there, one for each thing, the company as Grasp's Attio has it with its
 * people and deals, the calls with it, and its papers.
 *
 * Read only: the prototype corrects the papers and the contacts here, but
 * the company's own Grasp takes nothing from the admin yet, so nothing
 * here can be changed. Where the model has nothing, because core doesn't
 * hold it yet, each part says so rather than show anything made up.
 */

/** Each contact by what they are there for, and what that is. */
const contactWords: Record<ContactRole, { label: string; what: string }> = {
  sponsor: { label: "Sponsor", what: "Wants this to happen, and decides." },
  admin: {
    label: "Admin",
    what: "Runs the company’s own onboarding and its workspace.",
  },
  billing: { label: "Billing", what: "Gets the invoices." },
  privacy: {
    label: "Privacy",
    what: "Answers for how the company handles personal data.",
  },
};

/** "Eva Bakker" becomes "EB"; lowercase particles such as "de" are skipped. */
const initialsOf = (name: string): string =>
  name
    .split(" ")
    .filter(
      (part) => part !== "" && part.startsWith(part.charAt(0).toUpperCase())
    )
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("") || name.charAt(0).toUpperCase();

/** A part of the page: its title, what it is, and what it holds under them. */
const Part = ({
  title,
  about,
  action,
  children,
}: {
  title: string;
  about: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="bg-card overflow-hidden rounded-xl border">
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium">{title}</h2>
        <p className="text-muted-foreground">{about}</p>
      </div>
      {action}
    </div>
    {children}
  </section>
);

/** The company: its name, what it does and where, how many people, and its website. */
const Company = () => {
  const { view } = useOrganization();
  const { org, company } = view;
  const people = view.people.length;
  const teams = view.teams.length;
  const about = [org.about, org.place]
    .filter((part) => part !== "")
    .join(" · ");
  const teamWords = `${teams} ${teams === 1 ? "team" : "teams"}`;
  return (
    <section className="bg-card flex flex-wrap items-start justify-between gap-x-8 gap-y-3 rounded-xl border px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="type-title">{org.name}</h2>
        <p className="text-muted-foreground">
          {about === "" ? "What it does is not known yet" : about}
        </p>
        <p className="text-muted-foreground text-xs">
          {people > 0
            ? `${people} ${people === 1 ? "person" : "people"} in ${teamWords}`
            : "Its people are not known until its own list is in"}
        </p>
      </div>
      {company.url === "" ? null : (
        <Button
          nativeButton={false}
          render={
            <a
              aria-label={`Open ${company.url} in a new tab`}
              href={`https://${company.url}`}
              rel="noopener noreferrer"
              target="_blank"
            />
          }
          size="sm"
          variant="outline"
        >
          {company.url}
          <ExternalLinkIcon data-icon="inline-end" />
        </Button>
      )}
    </section>
  );
};

/** Who Grasp deals with there: one person for each thing, or what that one is for. */
const Contacts = () => {
  const { view } = useOrganization();
  return (
    <Part
      about="One person for each thing. The interviews are with everyone else, and never show here."
      title="Who Grasp deals with"
    >
      <ul className="bg-border grid gap-px border-t sm:grid-cols-2">
        {CONTACT_ROLES.map((role) => {
          const contact = view.contacts[role];
          const { label, what } = contactWords[role];
          return (
            <li
              className="bg-card flex items-start justify-between gap-3 px-5 py-3.5"
              key={role}
            >
              <div className="flex min-w-0 items-start gap-3">
                {contact ? (
                  <Avatar>
                    <AvatarFallback>{initialsOf(contact.name)}</AvatarFallback>
                  </Avatar>
                ) : (
                  <span
                    aria-hidden
                    className="size-8 flex-none rounded-full border border-dashed"
                  />
                )}
                <div className="flex min-w-0 flex-col">
                  <span className="text-muted-foreground text-xs">{label}</span>
                  {contact ? (
                    <>
                      <span className="truncate">{contact.name}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {[contact.title, contact.email]
                          .filter((part) => part !== "")
                          .join(" · ")}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{what}</span>
                  )}
                </div>
              </div>
              {contact && contact.email !== "" ? (
                <Button
                  nativeButton={false}
                  render={
                    <a
                      aria-label={`Write to ${contact.name}`}
                      href={`mailto:${contact.email}`}
                    />
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  <MailIcon />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Part>
  );
};

/**
 * The deal the calls are about, as the prototype's Calls panel heads them:
 * the one won, or else the latest Attio lists.
 */
const mainDeal = (deals: readonly CrmDeal[]): CrmDeal | undefined =>
  deals.find((deal) => deal.stage?.kind === "won") ?? deals[0];

/** What the Calls panel says when it has no calls to list. */
const noCallsLine = (crm: Crm): string => {
  switch (crm.state) {
    case "read": {
      return crm.records.calls === null
        ? "Attio has no meetings or notes the admin can read."
        : "No call with the company in Attio yet.";
    }
    case "unread": {
      return `Attio can’t be read for it now: ${attioUnreadWords[crm.error]}.`;
    }
    case "not_linked": {
      return "Once it is linked to its company in Attio, above, this fills in by itself.";
    }
    case "not_connected": {
      return `Once ${sourceNames.attio} is connected, this fills in by itself.`;
    }
    default: {
      return crm satisfies never;
    }
  }
};

/**
 * Every call with the company, with who of it was in it, as the prototype's
 * Attio panel has them: its meetings in Attio, the newest first, or, in a
 * workspace without them, its notes there. Headed by the deal, its stage
 * and who at Grasp owns it.
 */
const Calls = () => {
  const { crm } = useOrganization().admin;
  const records = crm.state === "read" ? crm.records : null;
  const calls = records?.calls?.calls ?? [];
  const deal = records === null ? undefined : mainDeal(records.deals);
  const fromNotes = records?.calls?.from === "notes";
  return (
    <Part
      about={
        fromNotes
          ? "Every call with the company, from its notes in Attio."
          : "Every call with the company, with who was in it."
      }
      action={<Badge variant="outline">{sourceNames.attio}</Badge>}
      title="Calls"
    >
      {deal === undefined ? null : (
        <p className="text-muted-foreground border-t px-5 py-3">
          {[deal.name, deal.stage?.title ?? "", deal.owner ?? ""]
            .filter((part) => part !== "")
            .join(" · ")}
        </p>
      )}
      {calls.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-3">
          {noCallsLine(crm)}
        </p>
      ) : (
        <ul className="flex flex-col">
          {calls.map((call, index) => (
            <li
              className="grid grid-cols-1 gap-x-6 gap-y-0.5 border-t px-5 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]"
              // Two calls can share a day and a title; their order is the newest first.
              key={`${call.on}-${call.title}-${index}`}
            >
              <span className="text-muted-foreground tabular-nums">
                {formatDate(call.on)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span>{call.title || "A call with no title"}</span>
                {call.with.length === 0 ? null : (
                  <span className="text-muted-foreground text-xs">
                    {`With ${formatList(call.with)}`}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Part>
  );
};

/** Why Attio wasn't read now, as the rest of a sentence. */
const attioUnreadWords: Record<AttioReadError, string> = {
  refused: "Attio turned the admin’s key away",
  not_found: "Attio has no such company",
  invalid_answer: "what Attio answered can’t be read",
  timeout: "Attio didn’t answer in time",
  no_answer: "the request to Attio failed",
};

/** What the CRM part says in a line under its title. */
const crmLine = (crm: Crm): string => {
  switch (crm.state) {
    case "not_connected": {
      return `${sourceNames.attio} isn’t connected yet. Once it is, this fills in by itself.`;
    }
    case "not_linked": {
      return "Not linked to its company in Attio yet. Link it by the company’s record id, and this fills in by itself.";
    }
    case "unread": {
      return `Attio can’t be read for it now: ${attioUnreadWords[crm.error]}.`;
    }
    case "read": {
      return "As Grasp’s CRM has the company, its people and its deals.";
    }
    default: {
      return crm satisfies never;
    }
  }
};

/** One line of what Attio says: its label, and what stands there. */
const CrmLine = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-5 py-3">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className={value === "" ? "text-muted-foreground" : undefined}>
      {value === "" ? "Not known" : value}
    </dd>
  </div>
);

/** A deal in a line: its stage, what it is worth, and who owns it. */
const dealWords = (deal: CrmDeal): string =>
  [
    deal.stage?.title ?? "",
    deal.value === null
      ? ""
      : money(deal.value.amount, deal.value.currency ?? "EUR"),
    deal.owner === null ? "" : `owned by ${deal.owner}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");

/** What Attio says of the company: its record, its deals and its people. */
const CrmRecordLines = ({ records }: { records: CrmRecords }) => {
  const { company, deals, people } = records;
  return (
    <>
      <dl>
        <CrmLine label="Name in Attio" value={company.name ?? ""} />
        <CrmLine label="Domains" value={formatList(company.domains)} />
        <CrmLine label="Categories" value={formatList(company.categories)} />
        <CrmLine label="Employees" value={company.employeeRange ?? ""} />
      </dl>
      {company.url === null ? null : (
        <p className="border-t px-5 py-3">
          <a
            className="hover:text-foreground underline underline-offset-4"
            href={company.url}
            rel="noreferrer"
            target="_blank"
          >
            Open it in Attio
          </a>
        </p>
      )}
      <h3 className="text-muted-foreground border-t px-5 pt-3 pb-1 text-xs">
        Deals
      </h3>
      {deals.length === 0 ? (
        <p className="text-muted-foreground px-5 pb-3">None in Attio.</p>
      ) : (
        <ul className="flex flex-col">
          {deals.map((deal, index) => (
            <li
              className="flex flex-wrap items-baseline justify-between gap-x-6 px-5 py-2"
              // Two deals can share a name; their order is Attio's.
              key={`${deal.name}-${index}`}
            >
              <span className="truncate">
                {deal.name || "A deal with no name"}
              </span>
              <span className="text-muted-foreground text-xs">
                {dealWords(deal)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="text-muted-foreground border-t px-5 pt-3 pb-1 text-xs">
        People
      </h3>
      {people.length === 0 ? (
        <p className="text-muted-foreground px-5 pb-3">None in Attio.</p>
      ) : (
        <ul className="flex flex-col">
          {people.map((person, index) => (
            <li
              className="flex flex-wrap items-baseline justify-between gap-x-6 px-5 py-2"
              // Two people can share a name.
              key={`${person.name}-${index}`}
            >
              <span className="truncate">{person.name || "No name"}</span>
              <span className="text-muted-foreground truncate text-xs">
                {[person.title, person.email]
                  .filter((part) => part !== "")
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

/**
 * The company in Grasp's CRM: what Attio says of it, its deals and its
 * people, and the company record it is linked to, which staff link or
 * change here.
 */
const CrmPart = () => {
  const { admin } = useOrganization();
  const { crm } = admin;
  const recordId = crm.state === "not_linked" ? null : crm.recordId;
  return (
    <Part
      about={crmLine(crm)}
      action={<Badge variant="outline">{sourceNames.attio}</Badge>}
      title="In the CRM"
    >
      {crm.state === "read" ? <CrmRecordLines records={crm.records} /> : null}
      <AttioLink clientId={admin.client.id} recordId={recordId} />
    </Part>
  );
};

/** One line of the papers: what it is, and what stands there, or that nothing does yet. */
const Paper = ({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string | string[];
  wide?: boolean;
}) => {
  const lines = (typeof value === "string" ? [value] : value).filter(
    (line) => line !== ""
  );
  return (
    <div
      className={
        wide ? "flex flex-col gap-1 sm:col-span-2" : "flex flex-col gap-1"
      }
    >
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={lines.length === 0 ? "text-muted-foreground" : undefined}>
        {lines.length === 0
          ? "Not known yet"
          : lines.map((line) => (
              <span className="block" key={line}>
                {line}
              </span>
            ))}
      </dd>
    </div>
  );
};

/** Its papers: as it stands on the contract and on every invoice. */
const Papers = () => {
  const { company, unknown } = useOrganization().view;
  return (
    <Part
      about="As it stands on the contract and on every invoice."
      title="Its papers"
    >
      <dl className="grid gap-5 border-t px-5 py-5 sm:grid-cols-2">
        {/* Without a contract, the model's name for it is only the company's own. */}
        <Paper
          label="Name on the contract"
          value={unknown.contract ? "" : company.legalName}
        />
        <Paper label="Website" value={company.url} />
        <Paper label="Company register number" value={company.register} />
        <Paper label="VAT number" value={company.vat} />
        <Paper label="Address" value={company.address} wide />
      </dl>
    </Part>
  );
};

const Details = () => (
  <>
    <Company />
    <Contacts />
    <CrmPart />
    <Calls />
    <Papers />
  </>
);

/** An organization's Details: the company, who Grasp deals with, the CRM, its calls and its papers. */
export const Route = createFileRoute("/organizations/$clientId/details")({
  component: Details,
});

import { CONTACT_ROLES } from "@grasp-os/shared/admin/onboarding-admin";
import type { ContactRole } from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLinkIcon, MailIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useOrganization } from "../../../../admin/organization.tsx";
import { sourceNames } from "../../../../admin/sections.ts";

/**
 * An organization's Details, as the prototype has them
 * (grasplabs/prototype `components/admin/org-details.tsx` and the Attio
 * panel of `source-panels.tsx`): the company itself, who Grasp deals with
 * there, one for each thing, the calls with it, and its papers.
 *
 * Read only: the prototype corrects the papers and the contacts here, but
 * the company's own Grasp takes nothing from the console yet, so nothing
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
        <h2 className="text-2xl leading-tight font-medium tracking-tight">
          {org.name}
        </h2>
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
 * Every call with the company, with who was in it: from Attio, which the
 * console doesn't read yet, so it says where they will come from.
 */
const Calls = () => (
  <Part
    about="Every call with the company, with who was in it."
    action={<Badge variant="outline">{sourceNames.attio}</Badge>}
    title="Calls"
  >
    <p className="text-muted-foreground border-t px-5 py-3">
      {`Once ${sourceNames.attio} is connected, this fills in by itself.`}
    </p>
  </Part>
);

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
    <Calls />
    <Papers />
  </>
);

/** An organization's Details: the company, who Grasp deals with, its calls and its papers. */
export const Route = createFileRoute("/admin/organizations/$clientId/details")({
  component: Details,
});

import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { OrgBrief } from "../../../admin/org-brief.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { Section } from "../../../admin/section.tsx";
import { needWhere, sectionTo, sectionWords } from "../../../admin/sections.ts";
import { needLine } from "../../../admin/words.ts";

/**
 * Everything that needs Grasp here, as the model works it out, each with
 * the section it is settled in: the overview of every organization shows
 * only the first few of all of them.
 */
const NeedsHere = () => {
  const { admin, view } = useOrganization();
  if (view.needs.length === 0) {
    return (
      <Section title="Needs Grasp">
        <p className="text-muted-foreground border-t px-5 py-4">
          Nothing needs Grasp here right now.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Needs Grasp">
      <ul className="flex flex-col">
        {view.needs.map((need, index) => {
          const text = needLine(need, view);
          const { section, search } = needWhere(need);
          return (
            <li
              className="flex items-center justify-between gap-4 border-t px-5 py-3"
              // The same need can stand twice, for two teams.
              key={`${need.kind}-${index}`}
            >
              <span className="flex min-w-0 items-start gap-2.5">
                <span
                  aria-hidden
                  className="bg-status-attention mt-1.5 size-1.5 flex-none rounded-full"
                />
                <span>{text}</span>
              </span>
              <Button
                aria-label={`Open ${sectionWords[section].title}: ${text}`}
                nativeButton={false}
                render={
                  <Link
                    params={{ clientId: admin.client.id }}
                    search={search}
                    to={sectionTo[section]}
                  />
                }
                size="sm"
                variant="ghost"
              >
                {sectionWords[section].title}
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
};

const Overview = () => {
  const { admin, view } = useOrganization();
  return (
    <div className="grid items-start gap-6 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 xl:col-span-2">
        <NeedsHere />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <OrgBrief clientId={admin.client.id} view={view} />
      </div>
    </div>
  );
};

/**
 * An organization's overview: what needs Grasp there, and beside it the
 * brief for the next call. How it stands is in its column, on every section.
 */
export const Route = createFileRoute("/organizations/$clientId/")({
  component: Overview,
});

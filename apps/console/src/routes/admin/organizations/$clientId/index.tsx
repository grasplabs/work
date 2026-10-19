import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { OrgBrief } from "../../../../admin/org-brief.tsx";
import { OrgHealth } from "../../../../admin/org-health.tsx";
import { useOrganization } from "../../../../admin/organization.tsx";
import {
  needSection,
  sectionTo,
  sectionWords,
} from "../../../../admin/sections.ts";
import { needLine } from "../../../../admin/words.ts";

/**
 * Everything that needs Grasp here, as the model works it out, each with
 * the section it is settled in: the overview of every organization shows
 * only the first few of all of them.
 */
const NeedsHere = () => {
  const { admin, view } = useOrganization();
  if (view.needs.length === 0) {
    return null;
  }
  return (
    <section className="bg-card overflow-hidden rounded-xl border">
      <div className="flex flex-col gap-0.5 px-5 py-4">
        <h2 className="font-medium">Needs Grasp</h2>
        <p className="text-muted-foreground">The most pressing first.</p>
      </div>
      <ul className="flex flex-col">
        {view.needs.map((need, index) => {
          const text = needLine(need, view);
          const section = needSection(need);
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
    </section>
  );
};

const Overview = () => {
  const { admin, view } = useOrganization();
  return (
    <>
      <OrgHealth
        clientId={admin.client.id}
        snapshot={admin.snapshot}
        view={view}
      />
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-2">
          <NeedsHere />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <OrgBrief clientId={admin.client.id} view={view} />
        </div>
      </div>
    </>
  );
};

/**
 * An organization's overview, as the prototype's (`org-home.tsx`) has it:
 * how it is doing on top, what needs Grasp there, and beside it the brief
 * for the next call.
 */
export const Route = createFileRoute("/admin/organizations/$clientId/")({
  component: Overview,
});

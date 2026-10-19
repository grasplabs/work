import { brainOf } from "@grasp-os/shared/admin/admin-health";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useOrganization } from "../../../../admin/organization.tsx";
import { BarList, Figure } from "../../../../admin/parts.tsx";
import { knowledgeSourceWords, plural } from "../../../../admin/words.ts";

/** A part of the section: its title, what it is for, and what it shows. */
const BrainPart = ({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) => (
  <section className="bg-card overflow-hidden rounded-xl border">
    <div className="flex flex-col gap-0.5 px-5 py-4">
      <h2 className="font-medium">{title}</h2>
      <p className="text-muted-foreground">{description}</p>
    </div>
    {children}
  </section>
);

/**
 * The company's brain, as the prototype shows it
 * (grasplabs/prototype `components/admin/org-brain.tsx`): first the
 * counts it stands on, so Grasp can tell how healthy it is before
 * anything is built on it; then how much of each source is in and how
 * well each team was heard. Every figure is the model's (`brainOf`).
 *
 * Core sends the console counts only, never the brain itself: what
 * people said and the facts written down stay in the company's own
 * Grasp. So this section always shows the prototype's state for a
 * brain that isn't shared with Grasp's staff. Showing the brain where
 * a company shares it needs that consent recorded and a read of it
 * from core, neither of which exists yet.
 *
 * Not here yet, as the prototype has it: a team's name opening its
 * place under Organization.
 */
const BrainSection = () => {
  const { admin, view } = useOrganization();
  const brain = brainOf(view);
  const taking = brain.teams.filter((team) => !team.off).length;
  const { percent, threshold, covered, differs } = brain;
  const stillOpen =
    differs > 0
      ? `${differs} ${plural(differs, "piece", "pieces")} of work told two ways, nobody knows why yet`
      : "questions for the next interviews";
  return (
    <>
      <section
        aria-label="The brain in numbers"
        className="overflow-hidden rounded-xl border"
      >
        <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-5">
          <Figure
            label="Known"
            ring={{ value: percent, of: 100 }}
            sub={`Opens at ${threshold}%`}
            value={`${percent}%`}
          />
          <Figure
            attention={view.closed && covered < taking}
            label="Teams heard"
            ring={{ value: covered, of: taking }}
            value={`${covered} of ${taking}`}
          />
          <Figure label="Agreed interviews" value={brain.interviews} />
          <Figure label="Facts agreed to" value={brain.facts} />
          <Figure
            attention={differs > 0}
            className="col-span-2 lg:col-span-1"
            label="Still open"
            sub={stillOpen}
            value={brain.questions}
          />
        </div>
      </section>

      <p className="text-muted-foreground">
        {`${admin.client.name} doesn’t share its brain with Grasp’s staff, so only its counts show here. What people said stays in their own interviews.`}
      </p>

      <BrainPart
        description="Each source of what Grasp knows, and how much of it is in. The largest gap is first."
        title="What it stands on"
      >
        <div className="border-t px-5 py-4">
          {brain.sources.length > 0 ? (
            <BarList
              label="How much of each source is in"
              rows={brain.sources.map(({ source, known }) => {
                const share = Math.round(known * 100);
                return {
                  id: source,
                  label: knowledgeSourceWords[source],
                  value: share,
                  shown: `${share}%`,
                };
              })}
            />
          ) : (
            // The company's own Grasp counts what is known as one number, without its parts.
            <p className="text-muted-foreground">
              The company’s own Grasp counts what is known as one number, so how
              much of each source is in doesn’t show here yet.
            </p>
          )}
        </div>
      </BrainPart>

      <BrainPart
        description="What each team’s people agreed to, and how much of its work Grasp knows."
        title="Team by team"
      >
        {brain.teams.length > 0 ? (
          <div className="@container border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead variant="card">Team</TableHead>
                  <TableHead className="text-right" variant="card">
                    Interviews
                  </TableHead>
                  <TableHead
                    className="hidden text-right @lg:table-cell"
                    variant="card"
                  >
                    Facts
                  </TableHead>
                  <TableHead className="text-right" variant="card">
                    Work known
                  </TableHead>
                  <TableHead
                    className="hidden text-right @md:table-cell"
                    variant="card"
                  >
                    Open
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {brain.teams.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell className="whitespace-normal" variant="card">
                      <span className={cn(team.off && "text-muted-foreground")}>
                        {team.name}
                        {team.off ? (
                          <span className="block text-xs">
                            Does not take part
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      <span className="tabular-nums">
                        {team.off ? "–" : `${team.agreed} of ${team.asked}`}
                      </span>
                    </TableCell>
                    <TableCell
                      className="hidden text-right @lg:table-cell"
                      variant="card"
                    >
                      <span className="tabular-nums">{team.facts}</span>
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      <span className="tabular-nums">
                        {team.works === 0
                          ? "–"
                          : `${team.known} of ${team.works}`}
                      </span>
                    </TableCell>
                    <TableCell
                      className="hidden text-right @md:table-cell"
                      variant="card"
                    >
                      <span className="tabular-nums">{team.questions}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground border-t px-5 py-4">
            No teams yet: they come with who works where.
          </p>
        )}
      </BrainPart>
    </>
  );
};

/** An organization's Brain: the counts its brain stands on, team by team. */
export const Route = createFileRoute("/admin/organizations/$clientId/brain")({
  component: BrainSection,
});

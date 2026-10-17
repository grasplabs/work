/**
 * What to take into the next conversation with a company, ported from the
 * prototype (grasplabs/prototype `components/admin/org-brief.tsx`): where
 * it stands, what to bring up with it, what Grasp doesn't know yet, and
 * once it is open where Grasp could do more. The same brief the
 * prototype's chat and MCP give (`briefOf`).
 *
 * Not here yet, as the prototype has it: its button to prepare the call
 * with Grasp's chat, which the console doesn't have.
 */
import { briefOf } from "@grasp-os/shared/admin/admin-brief";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { needSection, sectionTo } from "./sections.ts";
import { knowledgeWords, needLine, stageWords, whole } from "./words.ts";

const linkClass =
  "focus-visible:ring-ring/50 rounded-sm text-left underline-offset-4 outline-none hover:underline focus-visible:ring-3";

/** One of the brief's lists, a dot before each line. */
const BriefList = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-1.5">
    <h3 className="text-muted-foreground text-xs">{title}</h3>
    <ul className="flex flex-col gap-1">{children}</ul>
  </div>
);

/** A line of a brief's list, its dot on its first line. */
const BriefItem = ({ children }: { children: ReactNode }) => (
  <li className="flex items-start gap-2">
    <span
      aria-hidden
      className="bg-muted-foreground mt-2 size-1 flex-none rounded-full"
    />
    <span className="min-w-0">{children}</span>
  </li>
);

export const OrgBrief = ({
  view,
  clientId,
}: {
  view: AdminView;
  clientId: string;
}) => {
  const brief = briefOf(view);
  const { percent, questions } = brief;
  const where = view.open ? "Open since the go" : stageWords[brief.stage];
  return (
    <section
      aria-labelledby="before-the-next-call"
      className="bg-card overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-0.5 px-5 py-4">
        <h2 className="font-medium" id="before-the-next-call">
          Before the next call
        </h2>
        <p className="text-muted-foreground">
          {where}. {percent}% of what Grasp needs is known.
        </p>
      </div>
      <div className="flex flex-col gap-4 border-t px-5 py-4">
        {brief.bringUp.length > 0 ? (
          <BriefList title="Bring up">
            {brief.bringUp.map((need, index) => (
              // The same need can stand twice, for two teams.
              <BriefItem key={`${need.kind}-${index}`}>
                <Link
                  className={linkClass}
                  params={{ clientId }}
                  to={sectionTo[needSection(need)]}
                >
                  {needLine(need, view)}
                </Link>
              </BriefItem>
            ))}
          </BriefList>
        ) : null}
        {brief.missing.length > 0 ? (
          <BriefList title="Not known yet">
            {brief.missing.map((each) => (
              <BriefItem key={each.source}>
                {knowledgeWords[each.source]}: {Math.round(each.known * 100)}%
                in
              </BriefItem>
            ))}
            {questions > 0 ? (
              <BriefItem>
                {questions === 1
                  ? "1 question nobody could answer yet"
                  : `${questions} questions nobody could answer yet`}
              </BriefItem>
            ) : null}
          </BriefList>
        ) : null}
        {brief.opportunities.length > 0 ? (
          <BriefList title="Where Grasp could do more">
            {brief.opportunities.map((each) => (
              <BriefItem key={each.id}>
                <Link
                  className={linkClass}
                  params={{ clientId }}
                  to={sectionTo.workflows}
                >
                  {each.name}: {whole(each.hours)} hours a week by hand
                </Link>
              </BriefItem>
            ))}
          </BriefList>
        ) : null}
        {brief.bringUp.length === 0 &&
        brief.missing.length === 0 &&
        brief.opportunities.length === 0 ? (
          <p className="text-muted-foreground">Nothing to bring up.</p>
        ) : null}
      </div>
    </section>
  );
};

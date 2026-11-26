/**
 * The hours in the work that is known, and what the workflows free of
 * them, ported from the prototype (grasplabs/prototype
 * `components/admin/org-value.tsx`). The hours come from what the people
 * who do the work said, counted for everyone who does it (`valueOf`), and
 * so rest on the company's drawn work.
 *
 * Not here yet, as the prototype has it: the hours in short and workflow
 * by workflow. Core doesn't send the drawn work yet, so the model knows no
 * hours, and the section says so, as the product says a page has nothing
 * yet, with the way to where the hours will come from; those come with
 * the work.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Link } from "@tanstack/react-router";

import { SectionToCome, useOrganization } from "./organization.tsx";
import { sectionTo, sectionWords } from "./sections.ts";
import type { OrgSection } from "./sections.ts";

/**
 * Why no hours are known yet, and where to go about it: the interviews
 * haven't started (its steps), are under way (its interviews), or the
 * work drawn from them isn't read (nowhere to go yet).
 */
const whyNone = ({
  told,
  approved,
  unread,
}: {
  told: boolean;
  approved: boolean;
  unread: boolean;
}): { why: string; way?: { section: OrgSection; words: string } } => {
  if (approved && unread) {
    return {
      why: "People agreed to what they said, but the work drawn from it isn’t read yet: the company’s own Grasp doesn’t hold it.",
    };
  }
  return told
    ? {
        why: "The team leads go first. Their teams follow the same day.",
        way: { section: "interviews", words: "To the interviews" },
      }
    : {
        why: "The interviews start once the company has told its team.",
        way: { section: "steps", words: "To its steps" },
      };
};

/** An organization's hours: none known yet, and why. */
export const Hours = () => {
  const { admin, view } = useOrganization();
  if (view.value.works.length > 0) {
    return <SectionToCome />;
  }
  const { why, way } = whyNone({
    told: view.told,
    approved: view.interviews.some((interview) => interview.approved),
    unread: view.unknown.works,
  });
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia icon={sectionWords.value.icon} />
        <EmptyTitle level={2}>No hours known yet</EmptyTitle>
        <EmptyDescription>
          {`They come from the interviews: how many of each piece of work there are, and how long one takes. ${why}`}
        </EmptyDescription>
      </EmptyHeader>
      {way === undefined ? null : (
        <EmptyContent>
          <Button asChild variant="outline">
            <Link
              params={{ clientId: admin.client.id }}
              to={sectionTo[way.section]}
            >
              {way.words}
            </Link>
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
};

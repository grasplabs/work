/**
 * The hours in the work that is known, and what the workflows free of
 * them, ported from the prototype (grasplabs/prototype
 * `components/admin/org-value.tsx`). The hours come from what the people
 * who do the work said, counted for everyone who does it (`valueOf`), and
 * so rest on the company's drawn work.
 *
 * Not here yet, as the prototype has it: the hours in short and workflow
 * by workflow. Core doesn't send the drawn work yet, so the model knows no
 * hours, and the section says so; those come with the work.
 */
import { SectionToCome, useOrganization } from "./organization.tsx";
import { Panel } from "./parts.tsx";

/** Why no hours are known yet: the interviews haven't started, are under way, or the work drawn from them isn't read. */
const whyNone = ({
  told,
  approved,
}: {
  told: boolean;
  approved: boolean;
}): string => {
  if (approved) {
    return "People agreed to what they said, but the work drawn from it isn’t read yet: the company’s own Grasp doesn’t hold it.";
  }
  return told
    ? "The team leads go first. Their teams follow the same day."
    : "The interviews start once the company has told its team.";
};

/** An organization's hours: none known yet, and why. */
export const Hours = () => {
  const { view } = useOrganization();
  if (view.value.works.length > 0) {
    return <SectionToCome />;
  }
  return (
    <Panel
      description="They come from the interviews: how many of each piece of work there are, and how long one takes."
      title="No hours known yet"
    >
      <p className="text-muted-foreground border-t px-5 py-4">
        {whyNone({
          told: view.told,
          approved: view.interviews.some((interview) => interview.approved),
        })}
      </p>
    </Panel>
  );
};

import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { BrainIcon, Icon } from "@grasp-os/ui/lib/icons";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

// A note or a part of the brain that isn't there, as the reference's
// frame says it (#2503's NotFoundState in `frame/page-states.tsx`, which
// is still the old kit's here): the page's own empty state, the Brain's
// mark, what wasn't found, and the way on to Chat.

export const BrainNotFound = ({ title }: { title: string }) => {
  const { t } = useLingui();
  return (
    <Empty size="lg">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon icon={BrainIcon} />
        </EmptyMedia>
        <EmptyTitle level={1}>{title}</EmptyTitle>
        <EmptyDescription>
          <Trans>It may have been renamed or removed.</Trans>
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/">{t`Go to Chat`}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
};

import {
  useMutation,
  usePaginatedQuery,
  useUser,
} from "@grasp-os/runtime/react";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { api } from "@server/_generated/api";
import type { Doc } from "@server/_generated/dataModel";

import { formatMoney } from "../lib/money";
import { Decide } from "./decide";

type Request = Doc<"requests">;

export type Status = Request["status"];

const badges = {
  pending: { label: "Pending", variant: "attention" },
  approved: { label: "Approved", variant: "passed" },
  rejected: { label: "Rejected", variant: "destructive" },
} as const;

const RequestActions = ({ request }: { request: Request }) => {
  const user = useUser();
  const withdraw = useMutation(api.requests.withdraw);
  if (request.status !== "pending" || user === undefined) {
    return null;
  }
  if (request._ownerId === user.id) {
    return (
      <Button
        onClick={async () => await withdraw({ id: request._id })}
        size="sm"
        variant="outline"
      >
        Withdraw
      </Button>
    );
  }
  return user.roles.includes("builder") ? (
    <Decide id={request._id} key={request._updatedAt} title={request.title} />
  ) : null;
};

const RequestItem = ({ request }: { request: Request }) => {
  const { label, variant } = badges[request.status];
  const { decision } = request;
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>
          {request.title} · {formatMoney(request.amount)}
        </ItemTitle>
        {request.details === "" ? null : (
          <ItemDescription>{request.details}</ItemDescription>
        )}
        {decision === null ? null : (
          <ItemDescription>
            {decision.by}
            {decision.note === "" ? "" : `: ${decision.note}`}
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <Badge variant={variant}>{label}</Badge>
        <RequestActions request={request} />
      </ItemActions>
    </Item>
  );
};

export const Requests = ({ status }: { status: Status }) => {
  const { items, hasMore, isLoading, loadMore } = usePaginatedQuery(
    api.requests.list,
    { status },
    { initialPageSize: 20 }
  );
  if (isLoading && items.length === 0) {
    return <Spinner />;
  }
  if (items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing here</EmptyTitle>
          <EmptyDescription>
            Requests show here as they are made and decided.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup>
      {items.map((request) => (
        <RequestItem key={request._id} request={request} />
      ))}
      {hasMore ? (
        <Button
          disabled={isLoading}
          onClick={() => {
            loadMore();
          }}
          variant="outline"
        >
          More
        </Button>
      ) : null}
    </ItemGroup>
  );
};

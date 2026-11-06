import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { api } from "@server/_generated/api";
import type { Doc } from "@server/_generated/dataModel";
import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";

type ColumnId = Doc<"cards">["column"];

export const columns: readonly { id: ColumnId; title: string }[] = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "Doing" },
  { id: "done", title: "Done" },
];

const CardItem = ({ card }: { card: Doc<"cards"> }) => {
  const move = useMutation(api.cards.move);
  const remove = useMutation(api.cards.remove);
  const at = columns.findIndex(({ id }) => id === card.column);
  const previous = columns[at - 1];
  const next = columns[at + 1];
  const moveTo = async (column: ColumnId) =>
    await move({ id: card._id, expectedRevision: card._rev, column });
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{card.title}</ItemTitle>
      </ItemContent>
      <ItemActions>
        {previous === undefined ? null : (
          <Button
            aria-label={`Move to ${previous.title}`}
            onClick={async () => await moveTo(previous.id)}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowLeftIcon />
          </Button>
        )}
        {next === undefined ? null : (
          <Button
            aria-label={`Move to ${next.title}`}
            onClick={async () => await moveTo(next.id)}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowRightIcon />
          </Button>
        )}
        <Button
          aria-label="Remove"
          onClick={async () =>
            await remove({ id: card._id, expectedRevision: card._rev })
          }
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </ItemActions>
    </Item>
  );
};

export const Column = ({ id, title }: { id: ColumnId; title: string }) => {
  const cards = useQuery(api.cards.list, { column: id });
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Badge>{cards?.length ?? 0}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {cards === undefined ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <ItemGroup>
            {cards.map((card) => (
              <CardItem card={card} key={card._id} />
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
};

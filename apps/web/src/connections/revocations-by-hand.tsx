import { revokeByHandAt } from "@grasp-os/shared/connect";
import type { RevocationToDo } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans } from "@lingui/react/macro";
import { Await } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";

import { formatDate } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { AppLogo } from "./app-logo.tsx";

// Access at an app Grasp couldn't remove itself (GRA-1197): when a
// connection was disconnected, or asked to connect again, connect revokes
// its grant at the provider, trying again until the provider takes it
// (connect's src/revocations.ts). One still refused after about a day, or
// given up, is shown here to the company's admins (and Grasp's staff,
// read-only), with what to do: remove Grasp's access at the app by hand.
// A personal connection is named by its owner, never its account.

/** The place to remove Grasp's access, as words with a link where one exists. */
const WhereToRemove = ({
  toDo,
  app,
}: {
  toDo: RevocationToDo;
  app: string;
}) => {
  const at = revokeByHandAt(toDo.provider);
  const owner = toDo.ownerName ?? "";
  const account = toDo.accountName ?? "";
  const link =
    at === undefined ? null : (
      <a
        className="underline"
        href={at}
        rel="noopener noreferrer"
        target="_blank"
      >
        {new URL(at).host + new URL(at).pathname}
      </a>
    );
  if (toDo.scope === "shared") {
    return link === null ? (
      <Trans>
        Remove Grasp&apos;s access in {app}&apos;s settings for connected apps,
        signed in as {account}.
      </Trans>
    ) : (
      <Trans>
        Remove Grasp at {link}, signed in as {account}.
      </Trans>
    );
  }
  if (toDo.ownerName === null) {
    return (
      <Trans>
        It was a former member&apos;s account: remove Grasp&apos;s access in{" "}
        {app}&apos;s admin settings.
      </Trans>
    );
  }
  return link === null ? (
    <Trans>
      Ask {owner} to remove Grasp&apos;s access in {app}&apos;s settings for
      connected apps.
    </Trans>
  ) : (
    <Trans>
      Ask {owner} to remove Grasp at {link}.
    </Trans>
  );
};

/** Where one revoke stands: still tried, or given up. */
const Standing = ({ toDo }: { toDo: RevocationToDo }) => {
  if (toDo.givenUpAt === null) {
    const tries = toDo.attempts;
    return (
      <Badge variant="outline">
        <Trans>Still trying · {tries} tries</Trans>
      </Badge>
    );
  }
  const date = formatDate(toDo.givenUpAt);
  return (
    <Badge variant="destructive">
      <Trans>Given up {date}</Trans>
    </Badge>
  );
};

const ToDoRow = ({
  toDo,
  nameOf,
}: {
  toDo: RevocationToDo;
  nameOf: (provider: string) => string;
}) => {
  const app = nameOf(toDo.provider);
  const since = formatDate(toDo.since);
  const whose =
    toDo.scope === "shared" ? (toDo.accountName ?? "") : (toDo.ownerName ?? "");
  return (
    <li className="flex items-start gap-3 py-2">
      <AppLogo logo={null} name={app} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {toDo.scope === "shared" ? (
            <Trans>
              {app}, shared: {whose}
            </Trans>
          ) : (
            <Trans>
              {app}, {whose}&apos;s own
            </Trans>
          )}
        </span>
        <span className="text-muted-foreground">
          {toDo.owedFor === "disconnected" ? (
            <Trans>Disconnected on {since}.</Trans>
          ) : (
            <Trans>Asked to connect again on {since}.</Trans>
          )}{" "}
          <WhereToRemove app={app} toDo={toDo} />
        </span>
      </div>
      <Standing toDo={toDo} />
    </li>
  );
};

const ToDoList = ({
  toDos,
  nameOf,
}: {
  toDos: Loaded<RevocationToDo[]>;
  nameOf: (provider: string) => string;
}) => {
  if (toDos.state !== "ready" || toDos.data.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="integrations-revoke-by-hand"
      className="flex flex-col gap-2"
    >
      <h2
        className="flex items-center gap-2 font-medium"
        id="integrations-revoke-by-hand"
      >
        <TriangleAlertIcon className="text-destructive size-4" />
        <Trans>Access to remove by hand</Trans>
      </h2>
      <p className="text-muted-foreground">
        <Trans>
          Grasp couldn&apos;t remove its own access at these apps. Until someone
          removes it there, it may still work.
        </Trans>
      </p>
      <ul className="flex flex-col divide-y">
        {toDos.data.map((toDo) => (
          <ToDoRow key={toDo.id} nameOf={nameOf} toDo={toDo} />
        ))}
      </ul>
    </section>
  );
};

/**
 * The revokes to make by hand, for admins and Grasp's staff: nothing at
 * all while there are none, or while they load.
 */
export const RevocationsByHand = ({
  toDos,
  nameOf,
}: {
  toDos: Promise<Loaded<RevocationToDo[]>> | undefined;
  nameOf: (provider: string) => string;
}) =>
  toDos === undefined ? null : (
    <Await fallback={null} promise={toDos}>
      {(loaded) => <ToDoList nameOf={nameOf} toDos={loaded} />}
    </Await>
  );

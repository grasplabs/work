import type {
  ListedConnection,
  ToolClassAudience,
} from "@grasp-os/shared/connect";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldStatus,
} from "@grasp-os/ui/components/field";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { RowAlert } from "./app/rows.tsx";
import { useChange } from "./use-change.ts";

// For an admin, on a shared connection to a connector made from a URL:
// for whom a chat's agent reads in it (Read company), everyone, one team
// or nobody (core's app-pointers.ts, `connections.pointApp`). A
// connector's tools name no resource, so the pointer is always the whole
// app. Core decides who may change it and checks every choice; changes in
// the app still wait for their person's press.

const styles = stylex.create({
  // The section's name in the card's flush rows, on their inset, as the
  // card's other sections have it (brain-audience.tsx).
  head: {
    marginInline: space["4"],
    marginBlockStart: space["3"],
    marginBlockEnd: space["1"],
  },
});

/** What the card reads: the company's pointers and its teams. */
interface Pointers {
  audience: ToolClassAudience;
  teams: { id: string; name: string }[];
}

/** The select's value for `audience`: a team by its ID, several as one. */
const valueOf = (audience: ToolClassAudience): string => {
  if (audience.who !== "teams") {
    return audience.who;
  }
  const [only, ...more] = audience.teams;
  return only !== undefined && more.length === 0 ? only : "teams";
};

/** The audience a chosen value names. */
const audienceOf = (value: string): ToolClassAudience =>
  value === "nobody" || value === "everyone"
    ? { who: value }
    : { who: "teams", teams: [value] };

/** The company's pointer at `connectionId` and its teams, as core has them now. */
const readPointers = async (
  core: CoreConnection,
  connectionId: string,
  signal?: AbortSignal
): Promise<Loaded<Pointers>> =>
  await loadFromCore(
    core,
    async (session): Promise<Pointers> => {
      const [pointers, teams] = await Promise.all([
        session.connections.appPointers(),
        session.organization.teams(),
      ]);
      return {
        audience: pointers.find((each) => each.connectionId === connectionId)
          ?.audience ?? { who: "nobody" },
        teams,
      };
    },
    signal
  );

/** Who chats read in `connection` for, chosen by an admin. */
export const ChatReads = ({
  connection,
  label,
}: {
  connection: ListedConnection;
  label: string;
}) => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const { busy, failure, change } = useChange();
  const [read, setRead] = useState<Loaded<Pointers>>();
  const { id } = connection;
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      const answer = await readPointers(core, id, left.signal);
      if (!left.signal.aborted) {
        setRead(answer);
      }
    };
    void load();
    return () => {
      left.abort();
    };
  }, [core, id]);
  if (read === undefined) {
    return null;
  }
  const title = t`Chats`;
  if (read.state !== "ready") {
    return (
      <section>
        <SectionHeader style={styles.head} size="sm" title={title} />
        <RowAlert variant="destructive">
          {notLoadedText(read, i18n) ?? ""}
        </RowAlert>
      </section>
    );
  }
  const { audience, teams } = read.data;
  const choices = [
    { value: "nobody", label: t`Nobody` },
    { value: "everyone", label: t`Everyone in the company` },
    ...(valueOf(audience) === "teams"
      ? [{ value: "teams", label: t`Some teams` }]
      : []),
    ...teams.map(({ id: value, name }) => ({ value, label: t`Team ${name}` })),
  ];
  return (
    <section>
      <SectionHeader style={styles.head} size="sm" title={title} />
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            <FieldLabel>{t`Whose chats read in it`}</FieldLabel>
            <FieldDescription>{t`Their assistant reads in all of ${label} for them. Anything it changes there waits for them to confirm it.`}</FieldDescription>
          </FieldContent>
          <Select
            disabled={busy}
            items={choices}
            onValueChange={(value: string | null) => {
              if (value === null || value === "teams") {
                return;
              }
              void (async () => {
                await change(async (session) => {
                  await session.connections.pointApp({
                    connectionId: id,
                    resources: [],
                    audience: audienceOf(value),
                  });
                });
                // What core has now, never a copy of the choice.
                setRead(await readPointers(core, id));
              })();
            }}
            value={valueOf(audience)}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
          <FieldStatus status={busy ? "loading" : "idle"} />
        </Field>
        {failure === undefined ? null : (
          <RowAlert variant="destructive">{failure}</RowAlert>
        )}
      </FieldGroup>
    </section>
  );
};

/**
 * How one organization is doing, ported from the prototype
 * (grasplabs/prototype `components/admin/org-health.tsx`): five signals
 * that each open their section, as the model works them out (`healthOf`).
 *
 * What core doesn't hold yet isn't counted as nothing: the contract and
 * the work drawn from the interviews are unknown to the model
 * (`view.unknown`), so the account says its contract isn't known yet
 * and the workflows say none is found yet, never a draft or a count of
 * zero standing for "not read". What the company connected comes from its
 * snapshot, not the model: a core that doesn't send it has the
 * connections say only whether the sign-in is in; one that does counts
 * what is connected and what stopped, and a workflow it built that works
 * in an app whose connection stopped needs Grasp.
 */
import type {
  AdminIntegrations,
  AdminSnapshot,
} from "@grasp-os/shared/admin-snapshot";
import { healthOf } from "@grasp-os/shared/admin/admin-health";
import type {
  HealthArea,
  HealthLevel,
  HealthSignal,
} from "@grasp-os/shared/admin/admin-health";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { listenDays } from "@grasp-os/shared/admin/onboarding-admin";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";

import { sectionTo } from "./sections.ts";
import type { OrgSection } from "./sections.ts";

const mark: Record<HealthLevel, string> = {
  none: "bg-border",
  good: "bg-status-agreed",
  watch: "bg-status-attention/40",
  attention: "bg-status-attention",
};

const areaWords: Record<HealthArea, string> = {
  connections: "Connections",
  interviews: "Interviews",
  brain: "Brain",
  workflows: "Workflows",
  account: "Account",
};

const levelWords: Record<HealthLevel, string> = {
  none: "Not yet",
  good: "Good",
  watch: "Worth a look",
  attention: "Needs Grasp",
};

/** What core holds of what the signals count: the contract, the drawn work and the connections are unknown until it does. */
interface Held {
  contract: boolean;
  works: boolean;
  integrations: Connections | null;
}

/** What core says of the company's connections, as the signals count them. */
interface Connections {
  /** Its shared connections, and the apps its people connected their own of. */
  connected: number;
  /** Of those, how many someone must sign in to again, or Composio says stopped. */
  stopped: number;
  /** Its workflows that work in an app whose connection stopped. */
  stuck: number;
}

const connectionsOf = ({
  connected,
  personal,
  needed,
}: AdminIntegrations): Connections => ({
  connected: connected.length + personal.length,
  stopped:
    connected.filter(({ state }) => state === "again" || state === "stopped")
      .length + personal.filter(({ again }) => again > 0).length,
  stuck: new Set(
    needed
      .filter(({ state }) => state === "stopped")
      .map(({ workflow }) => workflow.id)
  ).size,
});

/** Where each signal is dealt with: once open, the workflows are about the hours they free. */
const sectionOf = (signal: HealthSignal): OrgSection => {
  switch (signal.area) {
    case "connections": {
      return "integrations";
    }
    case "workflows": {
      return signal.open ? "value" : "workflows";
    }
    case "account": {
      return "contract";
    }
    case "interviews":
    case "brain": {
      return signal.area;
    }
    default: {
      return signal satisfies never;
    }
  }
};

const interviewsLine = (
  signal: Extract<HealthSignal, { area: "interviews" }>,
  view: AdminView
): string => {
  if (!signal.told) {
    return "Not started";
  }
  const { talked, asked, day, quiet } = signal;
  if (quiet > 0) {
    return quiet === 1
      ? "1 team waits on its lead or went quiet"
      : `${quiet} teams wait on their lead or went quiet`;
  }
  return signal.closed
    ? `${talked} of ${asked} talked, closed`
    : `${talked} of ${asked} talked, day ${day} of ${listenDays(view.org)}`;
};

const accountLine = (
  signal: Extract<HealthSignal, { area: "account" }>,
  view: AdminView,
  held: Held
): string => {
  if (!held.contract) {
    return "Contract not known yet";
  }
  if (signal.needs.includes("contract")) {
    return "Contract not signed";
  }
  if (signal.needs.includes("ending")) {
    return "Contract ends soon";
  }
  if (signal.needs.includes("budget")) {
    return "More AI than the contract covers";
  }
  return view.contract.status === "signed"
    ? "Contract signed"
    : "No contract yet";
};

/** What one signal says under its name. */
const lineOf = (signal: HealthSignal, view: AdminView, held: Held): string => {
  switch (signal.area) {
    case "connections": {
      const stopped = held.integrations?.stopped ?? signal.stopped;
      if (stopped > 0) {
        return `${stopped} stopped: someone must sign in again`;
      }
      // The model's sign-in signal is the whole Connected step, leads named too: people in through the sign-in already say it is connected.
      if (!signal.signIn) {
        return view.state.client === "directory"
          ? "Sign-in connected, team leads not named yet"
          : "Sign-in not connected yet";
      }
      return held.integrations === null
        ? "Sign-in connected"
        : `${held.integrations.connected} connected`;
    }
    case "interviews": {
      return interviewsLine(signal, view);
    }
    case "brain": {
      return `${signal.percent}% known, opens at ${signal.threshold}%`;
    }
    case "workflows": {
      if ((held.integrations?.stuck ?? 0) > 0) {
        return "A connection they work in stopped";
      }
      if (!held.works) {
        return "No workflows found yet";
      }
      if (signal.stuck > 0) {
        return "A connection they work in stopped";
      }
      return signal.open
        ? `${signal.live} live, ${signal.designs} on their way`
        : `${signal.known} of ${signal.of} known`;
    }
    case "account": {
      return accountLine(signal, view, held);
    }
    default: {
      return signal satisfies never;
    }
  }
};

/**
 * A signal's level as the model has it; the workflows and the account say
 * nothing yet while core holds no drawn work or contract, for the model
 * would count the work's absence as none live once the company is open.
 */
const levelOf = (signal: HealthSignal, held: Held): HealthLevel => {
  // What core says stopped needs Grasp, whatever the model counts without it.
  const stopped =
    (signal.area === "connections" && (held.integrations?.stopped ?? 0) > 0) ||
    (signal.area === "workflows" && (held.integrations?.stuck ?? 0) > 0);
  if (stopped) {
    return "attention";
  }
  if (
    (signal.area === "workflows" && !held.works) ||
    (signal.area === "account" && !held.contract)
  ) {
    return "none";
  }
  return signal.level;
};

/**
 * How the company is doing, in five signals that each open their section:
 * what it connected, its interviews, its brain, its workflows and its
 * account. Green when all is well, orange when it needs Grasp, half orange
 * when it is worth a look, and grey before it says anything.
 */
export const OrgHealth = ({
  view,
  snapshot,
  clientId,
}: {
  view: AdminView;
  snapshot: AdminSnapshot;
  clientId: string;
}) => {
  const held: Held = {
    contract: !view.unknown.contract,
    works: !view.unknown.works,
    integrations:
      snapshot.integrations === null
        ? null
        : connectionsOf(snapshot.integrations),
  };
  return (
    <section
      aria-label="How the company is doing"
      className="overflow-hidden rounded-xl border"
    >
      <ul className="bg-border grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5">
        {healthOf(view).map((signal) => {
          const name = areaWords[signal.area];
          const level = levelOf(signal, held);
          const line = lineOf(signal, view, held);
          return (
            <li className="bg-card min-w-0" key={signal.area}>
              <Link
                aria-label={`${name}: ${levelWords[level]}. ${line}`}
                className="hover:bg-muted/60 focus-visible:ring-ring/50 flex h-full w-full flex-col gap-1 px-4 py-3 outline-none focus-visible:ring-3"
                params={{ clientId }}
                to={sectionTo[sectionOf(signal)]}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn("size-2 flex-none rounded-full", mark[level])}
                  />
                  <span className="font-medium">{name}</span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "text-xs",
                    level === "attention"
                      ? "text-status-attention"
                      : "text-muted-foreground"
                  )}
                >
                  {line}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

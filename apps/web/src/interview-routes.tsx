import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { CoreConnection } from "./core-connection.ts";
import { reportUncaughtErrors } from "./error-reports.ts";
import { ErrorText } from "./error-text.tsx";
import { UiWords } from "./frame/ui-words.tsx";
import { Actions, Page as Calm, Words } from "./interview/calm.tsx";
import { Frame } from "./interview/frame.tsx";
import { fromTheTop } from "./onboarding/field/poses.ts";
import { useRouteErrorReason } from "./route-error-reason.ts";
import { Route as rootRoute } from "./routes/__root.tsx";
import { Route as interviewRoute } from "./routes/interview.tsx";

// Someone's own interview (`/interview#<secret>`), loaded by main.tsx
// without the rest of the app (boot-path.ts): the people who open it are
// employees, often on a phone, who see nothing of Grasp but this page.
// The app's route tree (routeTree.gen.ts) imports what every route checks
// before it loads, and much of the app comes with it; this tree holds the
// root and the interview alone, wired as the generated one wires them.
// The interview leads nowhere else in the app: signing in leaves for
// core's sign-in and comes back here, and signing out loads the page anew.

// Where the interview sits under the root, set on its options as
// routeTree.gen.ts sets it (the route's `update`, whose type leaves out
// what only the generated tree sets).
Object.assign(interviewRoute.options, {
  id: "/interview",
  path: "/interview",
  getParentRoute: () => rootRoute,
});

const routeTree = rootRoute.addChildren([interviewRoute]);

// Its own connection to core, as the app's: when the session ends, the page
// loads again and asks who signs in.
const core = new CoreConnection({
  onSessionEnded: () => {
    window.location.reload();
  },
});

/**
 * The interview failed to show: why, as anywhere in the app
 * (route-error-reason.ts), laid out as the interview's own notices, and
 * trying again loads the page anew.
 */
const InterviewError = ({ error }: ErrorComponentProps) => {
  const { t } = useLingui();
  const reason = useRouteErrorReason(error);
  return (
    <Frame pose={fromTheTop}>
      <Calm>
        <Words
          line={<ErrorText>{reason}</ErrorText>}
          title={t`This page didn't load`}
        />
        <Actions>
          <Button
            onClick={() => {
              window.location.reload();
            }}
            variant="outline"
          >
            {t`Try again`}
          </Button>
        </Actions>
      </Calm>
    </Frame>
  );
};

const router = createRouter({
  routeTree,
  context: { core },
  defaultErrorComponent: InterviewError,
});

// What the page throws and never catches, reported with the route's pattern.
reportUncaughtErrors(() => router.state.matches.at(-1)?.fullPath);

/**
 * The interview, mounted afresh in each language, as the app's routes are
 * (app-routes.tsx). Damsko's components say their own words here too.
 */
export const Routes = () => {
  const { i18n } = useLingui();
  return (
    <UiWords>
      <RouterProvider key={i18n.locale} router={router} />
    </UiWords>
  );
};

import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";

/**
 * Why something in the chat failed, in core's words, where it failed:
 * Damsko's quiet Alert, said once as it appears; nothing when it didn't.
 */
export const FailureLine = ({ children }: { children?: string }) =>
  children === undefined ? null : (
    <Alert appearance="subtle" variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );

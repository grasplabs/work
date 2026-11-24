import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useMatch } from "@tanstack/react-router";

/**
 * Whether the signed-in person is one of the organization's own admins,
 * never Grasp staff; nobody is outside the signed-in pages.
 */
export const useMemberAdmin = (): boolean => {
  const shell = useMatch({ from: "/_shell", shouldThrow: false });
  const identity = shell?.context.identity;
  return identity !== undefined && isMemberAdmin(identity);
};

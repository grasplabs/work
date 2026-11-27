/**
 * Figures as the admin draws them (Damsko's Stat, in a StatGroup): one
 * whose source doesn't say it says why in words, never a bare dash; one
 * still being read holds its room with Damsko's skeleton.
 */
import { Stat } from "@grasp-os/ui/components/stat";

/** A figure its source doesn't give: `missing` in its place ("Not shared", "Not read"), and why. */
export const MissingFigure = ({
  label,
  missing,
  why,
}: {
  label: string;
  missing: string;
  why: string;
}) => <Stat change={why} label={label} value={missing} />;

/** A figure still being read: its label over a skeleton the size of its value and line. */
export const LoadingFigure = ({ label }: { label: string }) => (
  <Stat change="" label={label} loading value="" />
);

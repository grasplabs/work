import { Button } from "@grasp-os/ui/components/button";
import { FieldLabel } from "@grasp-os/ui/components/field";
import { Icon, InfoIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

// More about a setting behind an info mark beside its name, as the old
// library's setting row drew it: Damsko's Field has no part for it, so it
// is the feature's own, a ghost icon button whose tooltip says the rest.

const styles = stylex.create({
  // The label and the mark on one line, the mark never making it taller.
  row: { display: "flex", alignItems: "center", gap: space["1"] },
});

/** More about a setting, behind an info mark beside its name. */
export const InfoTip = ({
  children,
  about = "setting",
}: {
  children: string;
  /** What it says more about: a setting's row, or a section of the page. */
  about?: "setting" | "section";
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-label={
        about === "setting"
          ? t`More about this setting`
          : t`More about this section`
      }
      size="icon-xs"
      tooltip={children}
      variant="ghost"
    >
      <Icon icon={InfoIcon} />
    </Button>
  );
};

/** A setting's label with more about it behind an info mark beside it. */
export const LabelWithInfo = ({
  label,
  info,
}: {
  label: string;
  info: string;
}) => (
  <span {...stylex.props(styles.row)}>
    <FieldLabel>{label}</FieldLabel>
    <InfoTip>{info}</InfoTip>
  </span>
);

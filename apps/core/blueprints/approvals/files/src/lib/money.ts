import type { MoneyValue } from "@grasp-os/sdk";

export const formatMoney = ({ currency, minorUnits }: MoneyValue): string => {
  const format = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minorUnits / 10 ** digits);
};

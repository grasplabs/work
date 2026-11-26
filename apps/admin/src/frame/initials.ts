const nameParts = /\s+/u;

/**
 * Up to two letters of `name`, for the avatar: of the parts written with a
 * capital, so a particle such as "de" or "van" is passed over ("Sanne de
 * Wit" is SW). A name written all in small letters keeps its first two parts.
 */
export const initials = (name: string): string => {
  const parts = name.split(nameParts).filter((part) => part !== "");
  const capitalised = parts.filter((part) => {
    const first = part.charAt(0);
    return first !== first.toLocaleLowerCase();
  });
  return (capitalised.length > 0 ? capitalised : parts)
    .slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase())
    .join("");
};

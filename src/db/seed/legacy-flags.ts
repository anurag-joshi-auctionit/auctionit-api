export function legacyAvailFlagToIsActive(
  flag: number | null | undefined,
): boolean {
  if (flag == null) return true;
  return flag !== 0;
}

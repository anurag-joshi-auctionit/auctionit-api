export type NarrationValues = Record<string, string | number | null | undefined>;

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;
const GROUP_RE = /\s*\(([^()]*)\)/g;
const SEGMENT_SEPARATOR = " | ";
const NARRATION_MAX = 500;

function filled(values: NarrationValues, key: string): boolean {
  const v = values[key];
  return v != null && String(v).trim() !== "";
}

function allPlaceholdersEmpty(text: string, values: NarrationValues): boolean {
  const keys = [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
  return keys.length > 0 && keys.every((k) => !filled(values, k));
}

/**
 * Fills `{placeholder}` tokens. A parenthesised group or a ` | ` segment whose
 * placeholders are all empty is dropped, so optional details disappear
 * cleanly instead of leaving "UTR  |" or "(Ref )".
 */
export function renderNarration(
  template: string,
  values: NarrationValues,
): string {
  const withoutEmptyGroups = template.replace(GROUP_RE, (match, inner: string) =>
    allPlaceholdersEmpty(inner, values) ? "" : match,
  );
  const segments = withoutEmptyGroups
    .split(SEGMENT_SEPARATOR)
    .filter((segment) => !allPlaceholdersEmpty(segment, values));
  const text = segments
    .join(SEGMENT_SEPARATOR)
    .replace(PLACEHOLDER_RE, (_m, key: string) =>
      filled(values, key) ? String(values[key]).trim() : "",
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([:,)])/g, "$1")
    .replace(/[:\s]+$/, "")
    .trim();
  return text.length > NARRATION_MAX ? text.slice(0, NARRATION_MAX) : text;
}

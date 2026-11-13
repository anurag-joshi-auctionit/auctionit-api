import type { ImportRowIssue } from "@auctionit/xlsx-import/types";

export function clampPercent(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, size + i));
  }
  return batches;
}

export function schemaErrorsToIssues(
  rowErrors: { rowNumber: number; fieldErrors: Record<string, string[]> }[],
  formatFieldErrors: (fieldErrors: Record<string, string[]>) => string,
): ImportRowIssue[] {
  return rowErrors.map((row) => ({
    rowNumber: row.rowNumber,
    kind: "error" as const,
    reason: formatFieldErrors(row.fieldErrors) || "Validation failed",
    fieldErrors: row.fieldErrors,
  }));
}

const ISSUE_KIND_PRIORITY: Record<ImportRowIssue["kind"], number> = {
  error: 0,
  skipped: 1,
  uploaded: 2,
};

/** Prefer errors and skips over uploaded rows when truncating the response. */
export function capIssues(
  issues: ImportRowIssue[],
  maxIssues: number,
): {
  issues: ImportRowIssue[];
  issuesTruncated: boolean;
} {
  if (issues.length <= maxIssues) {
    return { issues, issuesTruncated: false };
  }

  const ranked = [...issues].sort((a, b) => {
    const byKind =
      ISSUE_KIND_PRIORITY[a.kind] - ISSUE_KIND_PRIORITY[b.kind];
    if (byKind !== 0) return byKind;
    return a.rowNumber - b.rowNumber;
  });

  return {
    issues: ranked
      .slice(0, maxIssues)
      .sort((a, b) => a.rowNumber - b.rowNumber || a.kind.localeCompare(b.kind)),
    issuesTruncated: true,
  };
}

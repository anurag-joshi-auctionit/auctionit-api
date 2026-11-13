export type ImportProgressPhase = "parse" | "import";

export type ImportProgress = {
  phase: ImportProgressPhase;
  processed: number;
  total: number;
  percent: number;
  label: string;
};

export type ImportRowIssue = {
  rowNumber: number;
  kind: "error" | "skipped" | "uploaded";
  reason: string;
  fieldErrors?: Record<string, string[]>;
};

export type ImportResult = {
  imported: number;
  failed: number;
  skipped: number;
  issues: ImportRowIssue[];
  issuesTruncated?: boolean;
};

export type ImportSseError = {
  message: string;
  code?: string;
};

/**
 * Excel import column: stable internal `key`, human `label` written to templates.
 * Upload matching accepts `label` and legacy `key` (plus optional aliases).
 */
export type ImportHeaderDef<K extends string = string> = {
  key: K;
  label: string;
  width: number;
  /** Extra header strings accepted on upload (normalized). */
  aliases?: readonly string[];
};

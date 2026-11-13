export type ExportCellValue = string | number | null | undefined;

export type ExportColumn<T> = {
  header: string;
  width?: number;
  /** Numeric-looking IDs kept as text; Excel's "Number Stored as Text" mark is suppressed. */
  asText?: boolean;
  value: (row: T) => ExportCellValue;
};

/** Title (row 1) and "Report generated at" (row 2) are written together. */
export type ReportHeaderOptions =
  | { title: string; generatedAt: string }
  | { title?: undefined; generatedAt?: undefined };

export type BuildRowsXlsxOptions<T> = {
  sheetName: string;
  columns: readonly ExportColumn<T>[];
  rows: readonly T[];
  creator?: string;
  freezeHeader?: boolean;
} & ReportHeaderOptions;

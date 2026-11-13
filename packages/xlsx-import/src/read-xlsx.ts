export type ReadXlsxMatrixOptions = {
  /** Sheet names tried in order (case-insensitive). Falls back to first sheet. */
  preferredSheetNames?: string[];
};

export type ReadXlsxMatrixResult = {
  matrix: unknown[][];
  sheetName: string | null;
};

/**
 * Read an XLSX buffer into a raw cell matrix (header row included).
 * Excel dates stay as serial numbers (`cellDates: false`).
 */
export async function readXlsxMatrix(
  buffer: ArrayBuffer | Buffer,
  options: ReadXlsxMatrixOptions = {},
): Promise<ReadXlsxMatrixResult> {
  const XLSX = await import("xlsx");
  const isNodeBuffer =
    typeof Buffer !== "undefined" && Buffer.isBuffer(buffer);
  const workbook = XLSX.read(buffer, {
    type: isNodeBuffer ? "buffer" : "array",
    cellDates: false,
  });

  const preferred = (options.preferredSheetNames ?? []).map((n) =>
    n.toLowerCase(),
  );
  const sheetName =
    preferred
      .map((want) =>
        workbook.SheetNames.find((n) => n.toLowerCase() === want),
      )
      .find((n): n is string => n != null) ?? workbook.SheetNames[0];

  if (!sheetName) {
    return { matrix: [], sheetName: null };
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { matrix: [], sheetName: null };
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  }) as unknown[][];

  return { matrix, sheetName };
}

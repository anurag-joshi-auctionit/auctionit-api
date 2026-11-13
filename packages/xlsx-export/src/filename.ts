/** Build an attachment filename like `service-invoices-2026-07-24.xlsx`. */
export function exportFilename(prefix: string, date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${prefix}-${yyyy}-${mm}-${dd}.xlsx`;
}

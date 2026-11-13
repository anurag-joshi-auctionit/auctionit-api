import { buildRowsXlsx, exportFilename, type ExportColumn } from "@auctionit/xlsx-export";
import type { ItemListRow } from "../../services/items.service.js";

const EXPORT_COLUMNS: ExportColumn<ItemListRow>[] = [
  { header: "Item ID", width: 12, value: (r) => r.itemId },
  { header: "Client", width: 28, value: (r) => r.clientName },
  { header: "Item Name", width: 32, value: (r) => r.name ?? "" },
  { header: "Material", width: 32, value: (r) => r.materialLabel ?? "" },
  {
    header: "Benchmark Material",
    width: 28,
    value: (r) => r.benchmarkMaterialLabel ?? "",
  },
  {
    header: "Status",
    width: 12,
    value: (r) => (r.isActive ? "Active" : "Inactive"),
  },
  { header: "Created At", width: 20, value: (r) => r.createdAt },
  { header: "Updated At", width: 20, value: (r) => r.updatedAt ?? "" },
];

export function buildItemsExportFilename(): string {
  return exportFilename("items-export");
}

export async function buildItemsExportXlsx(
  rows: ItemListRow[],
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Items",
    creator: "AuctionIT",
    columns: EXPORT_COLUMNS,
    rows,
  });
}

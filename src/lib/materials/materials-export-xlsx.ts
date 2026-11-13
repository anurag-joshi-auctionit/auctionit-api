import { buildRowsXlsx, exportFilename, type ExportColumn } from "@auctionit/xlsx-export";
import type { MaterialListItem } from "../../services/materials.service.js";

const EXPORT_COLUMNS: ExportColumn<MaterialListItem>[] = [
  { header: "Material ID", width: 12, value: (r) => r.id },
  { header: "Material", width: 32, value: (r) => r.label },
  { header: "Full Path", width: 48, value: (r) => r.breadcrumbLabel },
  { header: "Parent", width: 32, value: (r) => r.parentLabel ?? "" },
  { header: "Depth", width: 10, value: (r) => r.depth },
  {
    header: "Status",
    width: 12,
    value: (r) => (r.isActive ? "Active" : "Inactive"),
  },
  { header: "Created At", width: 20, value: (r) => r.createdAt },
  { header: "Updated At", width: 20, value: (r) => r.updatedAt },
];

export function buildMaterialsExportFilename(): string {
  return exportFilename("materials-export");
}

export async function buildMaterialsExportXlsx(
  rows: MaterialListItem[],
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Materials",
    creator: "AuctionIT",
    columns: EXPORT_COLUMNS,
    rows,
  });
}

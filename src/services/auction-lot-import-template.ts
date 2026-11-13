import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  GST_RATE_VALUES,
  LOADING_SCOPE_DISPLAY,
  AUCTION_LOT_IMPORT_DROPDOWN_KEYS,
  AUCTION_LOT_IMPORT_SHEET,
  AUCTION_LOT_IMPORT_TEMPLATE_DATA_ROWS,
  auctionLotImportTemplateHeaders,
} from "../lib/auction-lot-import-constants.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../lib/import/template-builder.js";
import {
  pgGetAuctionType,
  pgListLotEditorOptions,
} from "./auctions-pg.service.js";

const MASTERS_SHEET = "_masters";

export function buildAuctionLotImportTemplateFilename(
  auctionId: number,
): string {
  return `auction-${auctionId}-lots-import.xlsx`;
}

export async function buildAuctionLotImportTemplateXlsx(
  clientId: number,
  opts?: { auctionId?: number; auctionType?: string | null },
): Promise<Buffer> {
  const options = await pgListLotEditorOptions(clientId);
  const auctionType =
    opts?.auctionType ??
    (opts?.auctionId != null ? await pgGetAuctionType(opts.auctionId) : null);
  const headers = auctionLotImportTemplateHeaders(auctionType);

  const { workbook, sheet } = createImportWorkbook({
    sheetName: AUCTION_LOT_IMPORT_SHEET,
    headers,
  });

  const masters = workbook.addWorksheet(MASTERS_SHEET);
  masters.state = "veryHidden";

  masters.getCell("A1").value = "plantLocation";
  masters.getCell("B1").value = "materialLocation";
  masters.getCell("C1").value = "uom";
  masters.getCell("D1").value = "itemId";
  masters.getCell("E1").value = "benchmarkMaterial";
  masters.getCell("F1").value = "gstPercentage";
  masters.getCell("G1").value = "loadingScope";

  options.plantLocations.forEach((p, i) => {
    masters.getCell(`A${i + 2}`).value = p.name;
  });
  options.materialLocations.forEach((m, i) => {
    masters.getCell(`B${i + 2}`).value = m.name;
  });
  options.uoms.forEach((u, i) => {
    masters.getCell(`C${i + 2}`).value = u.code;
  });
  options.items.forEach((item, i) => {
    masters.getCell(`D${i + 2}`).value = `${item.name ?? ""}@@${item.id}`;
  });
  options.benchmarks.forEach((b, i) => {
    masters.getCell(`E${i + 2}`).value = b.label;
  });
  GST_RATE_VALUES.forEach((g: number, i: number) => {
    masters.getCell(`F${i + 2}`).value = g;
  });
  LOADING_SCOPE_DISPLAY.forEach((label: string, i: number) => {
    masters.getCell(`G${i + 2}`).value = label;
  });

  const named = (col: string, count: number, name: string) => {
    if (count <= 0) return;
    workbook.definedNames.add(
      `'${MASTERS_SHEET}'!$${col}$2:$${col}$${count + 1}`,
      name,
    );
  };

  named("A", options.plantLocations.length, "PlantLocations");
  named("B", options.materialLocations.length, "MaterialLocations");
  named("C", options.uoms.length, "Uoms");
  named("D", options.items.length, "Items");
  named("E", options.benchmarks.length, "BenchmarkMaterials");
  named("F", GST_RATE_VALUES.length, "GstRates");
  named("G", LOADING_SCOPE_DISPLAY.length, "LoadingScopes");

  const dropdownFormula: Record<
    (typeof AUCTION_LOT_IMPORT_DROPDOWN_KEYS)[number],
    string | null
  > = {
    plantLocation:
      options.plantLocations.length > 0 ? "=PlantLocations" : null,
    materialLocation:
      options.materialLocations.length > 0 ? "=MaterialLocations" : null,
    gstPercentage: "=GstRates",
    loadingScope: "=LoadingScopes",
    itemId: options.items.length > 0 ? "=Items" : null,
    uom: options.uoms.length > 0 ? "=Uoms" : null,
    benchmarkMaterial:
      options.benchmarks.length > 0 ? "=BenchmarkMaterials" : null,
  };

  const keyToCol = new Map(headers.map((h, i) => [h.key, i + 1]));

  const lotStartTimeCol = keyToCol.get("lotStartTime");
  const lotEndTimeCol = keyToCol.get("lotEndTime");
  // Text format so Excel does not coerce typed times to 12h AM/PM.
  if (lotStartTimeCol) {
    sheet.getColumn(lotStartTimeCol).numFmt = "@";
  }
  if (lotEndTimeCol) {
    sheet.getColumn(lotEndTimeCol).numFmt = "@";
  }

  for (let r = 2; r <= AUCTION_LOT_IMPORT_TEMPLATE_DATA_ROWS + 1; r++) {
    const row = sheet.getRow(r);

    if (lotStartTimeCol) {
      row.getCell(lotStartTimeCol).numFmt = "@";
    }
    if (lotEndTimeCol) {
      row.getCell(lotEndTimeCol).numFmt = "@";
    }

    for (const key of AUCTION_LOT_IMPORT_DROPDOWN_KEYS) {
      const formula = dropdownFormula[key];
      if (!formula) continue;
      const col = keyToCol.get(key);
      if (!col) continue;
      const cell = row.getCell(col);
      cell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [formula],
        showErrorMessage: true,
        errorTitle: AuctionsValidationMessages.IMPORT_TEMPLATE_INVALID_VALUE_TITLE,
        error: AuctionsValidationMessages.IMPORT_TEMPLATE_CHOOSE_VALUE,
      };
    }
  }

  return workbookToBuffer(workbook);
}

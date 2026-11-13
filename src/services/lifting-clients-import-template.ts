import ExcelJS from "exceljs";
import { LiftingClientsValidationMessages } from "@auctionit/messages/lifting-clients";
import {
  LIFTING_CLIENTS_IMPORT_EDITABLE_COLS,
  LIFTING_CLIENTS_IMPORT_SHEET,
  LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADERS,
  LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADER_KEYS,
} from "../lib/lifting-clients-import-constants.js";
import {
  liftingClientsService,
  type LiftingClientImportScope,
} from "./lifting-clients.service.js";
import { liftingClientDispositionMasterService } from "./masters/lifting-client-disposition.service.js";

const MASTERS_SHEET = "_masters";

export async function buildLiftingClientsImportTemplateXlsx(
  scope: LiftingClientImportScope,
): Promise<Buffer> {
  const [lots, dispositionOptions] = await Promise.all([
    liftingClientsService.listAllForImport(scope),
    liftingClientDispositionMasterService.list(true),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AuctionIT Admin";
  workbook.created = new Date();

  const liftingSheet = workbook.addWorksheet(LIFTING_CLIENTS_IMPORT_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const headerRow = liftingSheet.getRow(1);
  const editableHeaderKeys = new Set([
    "liftedQty",
    "liftedDate",
    "dispositionStatus",
    "remarks",
  ]);
  LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADERS.forEach((h, index) => {
    const col = index + 1;
    const cell = headerRow.getCell(col);
    cell.value = h.label;
    cell.font = { bold: editableHeaderKeys.has(h.key) };
    cell.protection = { locked: true };
    liftingSheet.getColumn(col).width = h.width;
    if (h.key === "liftedDate") {
      liftingSheet.getColumn(col).numFmt = "yyyy-mm-dd";
    }
  });
  headerRow.commit();

  liftingSheet.getColumn(1).hidden = true;

  const mastersSheet = workbook.addWorksheet(MASTERS_SHEET);
  mastersSheet.state = "veryHidden";
  mastersSheet.getCell("A1").value = "dispositionId";
  mastersSheet.getCell("B1").value = "dispositionLabel";

  dispositionOptions.forEach((option, index) => {
    const r = index + 2;
    mastersSheet.getCell(`A${r}`).value = Number(option.id);
    mastersSheet.getCell(`B${r}`).value = option.label;
  });

  const lastDispositionRow = dispositionOptions.length + 1;
  workbook.definedNames.add(
    `'${MASTERS_SHEET}'!$B$2:$B$${lastDispositionRow}`,
    "Dispositions",
  );

  const dispositionCol =
    LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADER_KEYS.indexOf("dispositionStatus") + 1;

  lots.forEach((lot, index) => {
    const row = liftingSheet.getRow(index + 2);
    const values: Record<
      (typeof LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADER_KEYS)[number],
      string | number
    > = {
      lotId: lot.id,
      auctionName: lot.auctionName,
      lotNumber: lot.lotNumber,
      approvedQty: lot.approvedQty,
      totalLiftedQty: lot.totalLiftedQty,
      balanceQty: lot.balanceQty,
      liftedQty: "",
      liftedDate: "",
      dispositionStatus: lot.dispositionStatusLabel,
      remarks: "",
    };

    LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADER_KEYS.forEach((key, colIndex) => {
      const col = colIndex + 1;
      const cell = row.getCell(col);
      cell.value = values[key];
      const editable = LIFTING_CLIENTS_IMPORT_EDITABLE_COLS.includes(
        col as (typeof LIFTING_CLIENTS_IMPORT_EDITABLE_COLS)[number],
      );
      cell.protection = { locked: !editable };
      if (key === "liftedDate") {
        cell.numFmt = "yyyy-mm-dd";
      }
    });

    const dispositionCell = row.getCell(dispositionCol);
    dispositionCell.dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ["=Dispositions"],
      showErrorMessage: true,
      errorTitle: LiftingClientsValidationMessages.IMPORT_EXCEL_DISPOSITION_TITLE,
      error: LiftingClientsValidationMessages.IMPORT_EXCEL_DISPOSITION_ERROR,
    };

    row.commit();
  });

  await liftingSheet.protect("", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
    pivotTables: false,
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function buildLiftingClientsImportTemplateFilename(): string {
  return "lifting-clients-import.xlsx";
}

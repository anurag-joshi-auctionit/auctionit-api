import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";

export const ADDITIONAL_FIELDS_IMPORT_SHEET = "AdditionalFields";
export const ADDITIONAL_FIELDS_MASTERS_SHEET = "_masters";
export const ADDITIONAL_FIELDS_DEFINED_NAME = "AdditionalFields";

/** Blank rows (after prefilled ones) that still get the field-name dropdown. */
export const ADDITIONAL_FIELDS_TEMPLATE_SPARE_ROWS = 200;

/** Cap issues returned to the client (required-per-lot checks can fan out). */
export const ADDITIONAL_FIELDS_IMPORT_MAX_ISSUES = 500;

export type AdditionalFieldsImportHeaderKey =
  | "auctionNo"
  | "lotNo"
  | "fieldName"
  | "fieldValue";

export const ADDITIONAL_FIELDS_IMPORT_TEMPLATE_HEADERS: ReadonlyArray<
  ImportHeaderDef<AdditionalFieldsImportHeaderKey>
> = [
  { key: "auctionNo", label: "Auction No.", width: 36, aliases: ["auction no"] },
  { key: "lotNo", label: "Lot No.", width: 18, aliases: ["lot no"] },
  {
    key: "fieldName",
    label: "Additional Field Name",
    width: 36,
    aliases: ["additional field"],
  },
  { key: "fieldValue", label: "Additional Field Value", width: 40 },
];

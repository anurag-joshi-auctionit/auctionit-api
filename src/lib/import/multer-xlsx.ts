import multer from "multer";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isXlsxFile(file: Express.Multer.File): boolean {
  if (file.originalname.toLowerCase().endsWith(".xlsx")) return true;
  const type = file.mimetype.toLowerCase();
  return type === XLSX_MIME || type === "";
}

export function createXlsxUpload(options: { maxBytes: number }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: options.maxBytes },
  });
}

export { XLSX_MIME };

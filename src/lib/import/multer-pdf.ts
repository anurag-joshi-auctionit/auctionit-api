import multer from "multer";

const PDF_MIME = "application/pdf";

export function isPdfFile(file: Express.Multer.File): boolean {
  if (file.originalname.toLowerCase().endsWith(".pdf")) return true;
  const type = file.mimetype.toLowerCase();
  return type === PDF_MIME || type === "application/x-pdf" || type === "";
}

export function createPdfUpload(options: { maxBytes: number }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: options.maxBytes },
  });
}

export { PDF_MIME };

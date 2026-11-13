import sharp from "sharp";

export async function convertImageToWebp(input: Buffer): Promise<Buffer> {
  return sharp(input).webp({ quality: 80 }).toBuffer();
}

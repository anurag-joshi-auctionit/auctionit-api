import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("legacy-temp-bidder-files", () => {
  let tempDir: string;
  const originalPath = process.env.LEGACY_BIDDER_TEMP_INFO_PATH;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "legacy-temp-bidder-"));
    process.env.LEGACY_BIDDER_TEMP_INFO_PATH = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.LEGACY_BIDDER_TEMP_INFO_PATH;
    } else {
      process.env.LEGACY_BIDDER_TEMP_INFO_PATH = originalPath;
    }
    vi.resetModules();
  });

  it("joins HTTP roots without breaking the scheme", async () => {
    const { joinLegacyTempBidderInfoPath } = await import(
      "./legacy-temp-bidder-files.js"
    );
    const url = joinLegacyTempBidderInfoPath(
      "http://example.com/UploadedFiles/TempBidderInfo",
      "CancelledCheque_1_abc.jpeg",
    );
    expect(url).toBe(
      "http://example.com/UploadedFiles/TempBidderInfo/CancelledCheque_1_abc.jpeg",
    );
  });

  it("trims trailing slash on HTTP roots", async () => {
    const { joinLegacyTempBidderInfoPath } = await import(
      "./legacy-temp-bidder-files.js"
    );
    const url = joinLegacyTempBidderInfoPath(
      "https://example.com/TempBidderInfo/",
      "PANCard_2.jpg",
    );
    expect(url).toBe("https://example.com/TempBidderInfo/PANCard_2.jpg");
  });

  it("parses IIS-style HTTP directory listings", async () => {
    const { parseHttpDirectoryListingHtml } = await import(
      "./legacy-temp-bidder-files.js"
    );
    const html = `
      <html><body>
        <a href="PANCard_1.jpg">PANCard_1.jpg</a>
        <a href="../">Parent Directory</a>
        <a href="GST_2.pdf">GST_2.pdf</a>
      </body></html>
    `;
    expect(parseHttpDirectoryListingHtml(html)).toEqual(
      new Set(["PANCard_1.jpg", "GST_2.pdf"]),
    );
  });

  it("lists local legacy filenames and discovers only existing files", async () => {
    await writeFile(join(tempDir, "PANCard_1.jpg"), "pan");
    await writeFile(join(tempDir, "GST_2.pdf"), "gst");

    const {
      discoverLegacyTempBidderFiles,
      legacyTempBidderFileExists,
      listLegacyTempBidderFileNames,
    } = await import("./legacy-temp-bidder-files.js");

    const listed = await listLegacyTempBidderFileNames();
    expect(listed).toEqual(new Set(["PANCard_1.jpg", "GST_2.pdf"]));

    expect(await legacyTempBidderFileExists("PANCard_1.jpg")).toBe(true);
    expect(await legacyTempBidderFileExists("missing.pdf")).toBe(false);

    const discovered = await discoverLegacyTempBidderFiles([
      "PANCard_1.jpg",
      "missing.pdf",
      "GST_2.pdf",
      "also-missing.jpg",
    ]);
    expect(discovered).toEqual(new Set(["PANCard_1.jpg", "GST_2.pdf"]));
  });
});

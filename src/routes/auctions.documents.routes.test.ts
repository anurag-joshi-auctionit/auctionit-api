import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import cookieParser from "cookie-parser";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { MAX_AUCTION_DOCUMENT_BYTES } from "../lib/auction-r2-keys.js";

vi.mock("../auth/middleware.js", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: 1,
      userLoginName: "admin",
      name: "Admin",
      role: { isAdmin: true, code: "admin" },
    };
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  requireAnyPermission:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
}));

vi.mock("../services/auctions.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/auctions.service.js")>();
  return {
    ...actual,
    auctionsService: {
      ...actual.auctionsService,
      uploadDocument: vi.fn(),
    },
  };
});

const { auctionsService } = await import("../services/auctions.service.js");
const auctionsRouter = (await import("./auctions.js")).default;

function createAuctionsTestApp() {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());
  app.use("/auctions", auctionsRouter);
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    },
  );
  return app;
}

describe("POST /auctions/:id/documents", () => {
  let app: ReturnType<typeof createAuctionsTestApp>;

  beforeEach(() => {
    app = createAuctionsTestApp();
    vi.mocked(auctionsService.uploadDocument).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when file is missing", async () => {
    const res = await request(app)
      .post("/auctions/1/documents")
      .field("documentTypeId", "1");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      AuctionsValidationMessages.DOCUMENT_FILE_REQUIRED,
    );
  });

  it("returns 400 when documentTypeId is missing", async () => {
    const res = await request(app)
      .post("/auctions/1/documents")
      .attach("file", Buffer.from("%PDF-1.4"), "catalogue.pdf");

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors?.documentTypeId).toBeDefined();
  });

  it("returns 400 when file exceeds multer size limit", async () => {
    const oversized = Buffer.alloc(MAX_AUCTION_DOCUMENT_BYTES + 1, 0x25);
    const res = await request(app)
      .post("/auctions/1/documents")
      .field("documentTypeId", "1")
      .attach("file", oversized, "catalogue.pdf");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      AuctionsValidationMessages.DOCUMENT_FILE_TOO_LARGE(5),
    );
    expect(auctionsService.uploadDocument).not.toHaveBeenCalled();
  });

  it("uploads a small PDF via multipart", async () => {
    vi.mocked(auctionsService.uploadDocument).mockResolvedValue({
      id: 10,
      documentTypeId: 1,
      fileName: "catalogue.pdf",
    } as never);

    const res = await request(app)
      .post("/auctions/1/documents")
      .field("documentTypeId", "1")
      .attach("file", Buffer.from("%PDF-1.4"), "catalogue.pdf");

    expect(res.status).toBe(201);
    expect(auctionsService.uploadDocument).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        documentTypeId: 1,
        originalFileName: "catalogue.pdf",
        buffer: expect.any(Buffer),
      }),
      1,
    );
  });
});

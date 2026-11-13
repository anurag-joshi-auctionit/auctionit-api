import {
  BiddersErrorMessages,
  BiddersValidationMessages,
} from "@auctionit/messages/bidders";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { AuthUser } from "../services/auth.service.js";

vi.mock("../auth/middleware.js", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: 1,
      userLoginName: "admin",
      name: "Admin",
      role: {
        id: 1,
        code: "admin",
        name: "Admin",
        description: null,
        isAdmin: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    } as AuthUser;
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

vi.mock("../services/bidder-documents.service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../services/bidder-documents.service.js")
  >();
  return {
    ...actual,
    listActiveBidderDocumentTypes: vi.fn(),
    listBidderDocuments: vi.fn(),
    listBidderDocumentHistory: vi.fn(),
    uploadBidderDocument: vi.fn(),
  };
});

const { createApp } = await import("../app.js");
const {
  biddersService,
  BidderAlreadyExemptedError,
  BidderAlreadyBlockedError,
  BidderNotExemptedError,
} = await import("../services/bidders.service.js");
const bidderDocumentsService = await import(
  "../services/bidder-documents.service.js"
);

const validBidder = {
  companyName: "Acme Bidder",
  locationId: 1,
  pincode: "560001",
  pan: "ABCDE1234F",
  gstin: "07ABCDE1234F1Z5",
  materials: [1],
  user: {
    name: "John Doe",
    userLoginName: "johndoe",
    emailId: "john@example.com",
    phoneNumber: "9876543210",
  },
};

describe("POST /bidders", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it("returns 400 with fieldErrors for invalid company PAN", async () => {
    const res = await request(app)
      .post("/bidders")
      .send({
        ...validBidder,
        pan: "INVALID",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(BiddersValidationMessages.VALIDATION_FAILED);
    expect(res.body.fieldErrors.pan).toEqual([
      BiddersValidationMessages.INVALID_PAN,
    ]);
  });

  it("returns 400 with fieldErrors when location is missing", async () => {
    const res = await request(app)
      .post("/bidders")
      .send({
        ...validBidder,
        locationId: null,
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.locationId).toContain(
      BiddersValidationMessages.LOCATION_REQUIRED,
    );
  });

  it("returns 400 when no materials are provided", async () => {
    const res = await request(app)
      .post("/bidders")
      .send({
        ...validBidder,
        materials: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.materials).toContain(
      BiddersValidationMessages.MATERIALS_REQUIRED,
    );
  });

  it("returns 400 when user email is missing", async () => {
    const res = await request(app)
      .post("/bidders")
      .send({
        ...validBidder,
        user: { ...validBidder.user, emailId: "" },
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors["user.emailId"]).toContain(
      BiddersValidationMessages.EMAIL_REQUIRED,
    );
  });

  it("returns 400 with fieldErrors for invalid user phone", async () => {
    const res = await request(app)
      .post("/bidders")
      .send({
        ...validBidder,
        user: { ...validBidder.user, phoneNumber: "12345" },
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors["user.phoneNumber"]).toEqual([
      BiddersValidationMessages.INVALID_PHONE,
    ]);
  });

  it("returns 400 with fieldErrors for invalid whatsapp phone", async () => {
    const res = await request(app)
      .post("/bidders")
      .send({
        ...validBidder,
        user: { ...validBidder.user, whatsappNumber: "12" },
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors["user.whatsappNumber"]).toEqual([
      BiddersValidationMessages.INVALID_PHONE,
    ]);
  });
});

describe("GET /bidders", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns paginated bidders with server-side params", async () => {
    const result = {
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
      counts: {
        total: 0,
        active: 0,
        inactive: 0,
        newLast30d: 0,
        unverified: 0,
      },
    };
    const list = vi.spyOn(biddersService, "list").mockResolvedValue(result);

    const res = await request(app).get(
      "/bidders?page=2&pageSize=20&search=acme&status=active&sortBy=companyName&sortOrder=asc&dateField=createdAt&dateFrom=2026-01-01&dateTo=2026-01-31",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        pageSize: 20,
        search: "acme",
        status: "active",
        sortBy: "companyName",
        sortOrder: "asc",
        dateField: "createdAt",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }),
    );
  });

  it("accepts last auction date filter and auction count sort", async () => {
    const result = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      counts: {
        total: 0,
        active: 0,
        inactive: 0,
        newLast30d: 0,
        unverified: 0,
      },
    };
    const list = vi.spyOn(biddersService, "list").mockResolvedValue(result);

    const res = await request(app).get(
      "/bidders?sortBy=auctionCount&sortOrder=desc&dateField=lastAuctionDate&dateFrom=2026-01-01&dateTo=2026-01-31",
    );

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        sortBy: "auctionCount",
        sortOrder: "desc",
        dateField: "lastAuctionDate",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }),
    );
  });
});

describe("GET /bidders/blocked", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns currently-blocked bidder/client pairs without matching /:id", async () => {
    const items = [
      {
        logId: 10,
        bidderId: 5,
        companyName: "Acme Bidder",
        clientId: 2,
        clientName: "Globex",
        reason: "Non-payment",
        blockedAt: "2026-01-02T00:00:00.000Z",
        blockedByName: "Admin User",
      },
    ];
    const result = { items, total: items.length, page: 1, pageSize: 10 };
    const listGloballyBlocked = vi
      .spyOn(biddersService, "listGloballyBlocked")
      .mockResolvedValue(result);
    const get = vi.spyOn(biddersService, "get");

    const res = await request(app).get("/bidders/blocked");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(listGloballyBlocked).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("GET /bidders/exempted", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns currently-exempted bidder/client pairs without matching /:id", async () => {
    const items = [
      {
        logId: 3,
        bidderId: 5,
        companyName: "Acme Bidder",
        clientId: 2,
        clientName: "Globex",
        reason: "VIP account",
        exemptedAt: "2026-01-02T00:00:00.000Z",
        exemptedByName: "Admin User",
      },
    ];
    const result = { items, total: items.length, page: 1, pageSize: 10 };
    const listGloballyExempted = vi
      .spyOn(biddersService, "listGloballyExempted")
      .mockResolvedValue(result);
    const get = vi.spyOn(biddersService, "get");

    const res = await request(app).get("/bidders/exempted");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(listGloballyExempted).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("POST /bidders/blocks", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 with fieldErrors when all required fields are empty", async () => {
    const res = await request(app).post("/bidders/blocks").send({
      bidderId: 0,
      clientId: 0,
      reason: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(BiddersValidationMessages.VALIDATION_FAILED);
    expect(res.body.fieldErrors.bidderId).toContain(
      BiddersValidationMessages.BIDDER_REQUIRED,
    );
    expect(res.body.fieldErrors.clientId).toContain(
      BiddersValidationMessages.CLIENT_REQUIRED,
    );
    expect(res.body.fieldErrors.reason).toContain(
      BiddersValidationMessages.BLOCK_REASON_REQUIRED,
    );
  });

  it("calls blockForClient and returns ok", async () => {
    const blockForClient = vi
      .spyOn(biddersService, "blockForClient")
      .mockResolvedValue({ ok: true });

    const res = await request(app).post("/bidders/blocks").send({
      bidderId: 1,
      clientId: 2,
      reason: "Non-payment",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(blockForClient).toHaveBeenCalledWith(1, 2, "Non-payment", 1);
  });

  it("returns 409 with fieldErrors when already blocked", async () => {
    vi.spyOn(biddersService, "blockForClient").mockRejectedValue(
      new BidderAlreadyBlockedError(),
    );

    const res = await request(app).post("/bidders/blocks").send({
      bidderId: 1,
      clientId: 2,
      reason: "Already blocked",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(BiddersErrorMessages.ALREADY_BLOCKED_FOR_CLIENT);
    expect(res.body.fieldErrors.clientId).toContain(
      BiddersErrorMessages.ALREADY_BLOCKED_FOR_CLIENT,
    );
  });
});

describe("POST /bidders/:id/blocks", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 with fieldErrors when reason is missing", async () => {
    const res = await request(app).post("/bidders/1/blocks").send({
      clientId: 2,
      reason: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(BiddersValidationMessages.VALIDATION_FAILED);
    expect(res.body.fieldErrors.reason).toContain(
      BiddersValidationMessages.BLOCK_REASON_REQUIRED,
    );
  });

  it("returns 400 with fieldErrors when clientId is missing", async () => {
    const res = await request(app).post("/bidders/1/blocks").send({
      reason: "Non-payment",
    });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.clientId).toBeDefined();
  });
});

describe("POST /bidders/exemptions", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 with fieldErrors when all required fields are empty", async () => {
    const res = await request(app).post("/bidders/exemptions").send({
      bidderId: 0,
      clientId: 0,
      reason: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(BiddersValidationMessages.VALIDATION_FAILED);
    expect(res.body.fieldErrors.bidderId).toContain(
      BiddersValidationMessages.BIDDER_REQUIRED,
    );
    expect(res.body.fieldErrors.clientId).toContain(
      BiddersValidationMessages.CLIENT_REQUIRED,
    );
    expect(res.body.fieldErrors.reason).toContain(
      BiddersValidationMessages.EXEMPT_REASON_REQUIRED,
    );
  });

  it("calls exemptForClient and returns ok", async () => {
    const exemptForClient = vi
      .spyOn(biddersService, "exemptForClient")
      .mockResolvedValue({ ok: true });

    const res = await request(app).post("/bidders/exemptions").send({
      bidderId: 1,
      clientId: 2,
      reason: "No subscription reminders",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(exemptForClient).toHaveBeenCalledWith(
      1,
      2,
      "No subscription reminders",
      1,
    );
  });

  it("returns 409 with fieldErrors when already exempted", async () => {
    vi.spyOn(biddersService, "exemptForClient").mockRejectedValue(
      new BidderAlreadyExemptedError(),
    );

    const res = await request(app).post("/bidders/exemptions").send({
      bidderId: 1,
      clientId: 2,
      reason: "Already on list",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(BiddersErrorMessages.ALREADY_EXEMPTED);
    expect(res.body.fieldErrors.clientId).toContain(
      BiddersErrorMessages.ALREADY_EXEMPTED,
    );
  });
});

describe("GET /bidders/:id/exemptions", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the bidder's client exemptions", async () => {
    const items = [
      {
        id: 7,
        clientId: 2,
        clientName: "Globex",
        isExempted: true,
        reason: "VIP account",
        createdAt: "2026-01-02T00:00:00.000Z",
        exemptedByName: "Admin User",
      },
    ];
    const result = { items, total: items.length, page: 1, pageSize: 10 };
    const listClientExemptionsForBidder = vi
      .spyOn(biddersService, "listClientExemptionsForBidder")
      .mockResolvedValue(result);

    const res = await request(app).get("/bidders/1/exemptions");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(listClientExemptionsForBidder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ page: 1, pageSize: 10 }),
    );
  });
});

describe("POST /bidders/:id/exemptions", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 with fieldErrors when clientId and reason are missing", async () => {
    const res = await request(app).post("/bidders/1/exemptions").send({
      clientId: 0,
      reason: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(BiddersValidationMessages.VALIDATION_FAILED);
    expect(res.body.fieldErrors.clientId).toContain(
      BiddersValidationMessages.CLIENT_REQUIRED,
    );
    expect(res.body.fieldErrors.reason).toContain(
      BiddersValidationMessages.EXEMPT_REASON_REQUIRED,
    );
  });

  it("calls exemptForClient and returns ok", async () => {
    const exemptForClient = vi
      .spyOn(biddersService, "exemptForClient")
      .mockResolvedValue({ ok: true });

    const res = await request(app).post("/bidders/1/exemptions").send({
      clientId: 2,
      reason: "No subscription reminders",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(exemptForClient).toHaveBeenCalledWith(
      1,
      2,
      "No subscription reminders",
      1,
    );
  });

  it("returns 409 with fieldErrors when already exempted for this client", async () => {
    vi.spyOn(biddersService, "exemptForClient").mockRejectedValue(
      new BidderAlreadyExemptedError(),
    );

    const res = await request(app).post("/bidders/1/exemptions").send({
      clientId: 2,
      reason: "Already on list",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(BiddersErrorMessages.ALREADY_EXEMPTED);
    expect(res.body.fieldErrors.clientId).toContain(
      BiddersErrorMessages.ALREADY_EXEMPTED,
    );
  });
});

describe("POST /bidders/:id/exemptions/:clientId/revoke", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls revokeExemptionForClient and returns ok", async () => {
    const revokeExemptionForClient = vi
      .spyOn(biddersService, "revokeExemptionForClient")
      .mockResolvedValue({ ok: true });

    const res = await request(app).post("/bidders/1/exemptions/2/revoke");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(revokeExemptionForClient).toHaveBeenCalledWith(1, 2, 1);
  });

  it("returns 409 when the bidder is not exempted for this client", async () => {
    vi.spyOn(biddersService, "revokeExemptionForClient").mockRejectedValue(
      new BidderNotExemptedError(),
    );

    const res = await request(app).post("/bidders/1/exemptions/2/revoke");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(BiddersErrorMessages.NOT_EXEMPTED);
  });
});

describe("GET /bidders/document-types", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.mocked(bidderDocumentsService.listActiveBidderDocumentTypes).mockResolvedValue(
      [{ documentTypeId: 1, name: "PAN Card", fileNamePrefix: "pan_card_" }],
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns active document types and allowed extensions", async () => {
    const res = await request(app).get("/bidders/document-types");

    expect(res.status).toBe(200);
    expect(res.body.documentTypes).toHaveLength(1);
    expect(res.body.allowedExtensions).toContain("pdf");
    expect(res.body.allowedExtensions).not.toContain("mp4");
  });
});

const sampleDocumentView = {
  id: 10,
  documentTypeId: 1,
  documentTypeName: "PAN Card",
  fileName: "pan_card_1_1719398400123.pdf",
  previewUrl: "https://signed.example/pan.pdf",
  createdAt: "2024-06-26T10:00:00.000Z",
  createdBy: 1,
  createdByName: "Admin",
};

describe("GET /bidders/:id/documents", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns latest documents per type with audit fields", async () => {
    vi.mocked(bidderDocumentsService.listBidderDocuments).mockResolvedValue({
      items: [sampleDocumentView],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    const res = await request(app).get("/bidders/1/documents");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      documentTypeName: "PAN Card",
      createdByName: "Admin",
    });
  });

  it("returns 404 when bidder is missing", async () => {
    vi.mocked(bidderDocumentsService.listBidderDocuments).mockRejectedValue(
      new (await import("../services/bidders.service.js")).BidderNotFoundError(),
    );

    const res = await request(app).get("/bidders/999/documents");

    expect(res.status).toBe(404);
  });
});

describe("GET /bidders/:id/documents/history", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns full upload history with audit fields", async () => {
    vi.mocked(bidderDocumentsService.listBidderDocumentHistory).mockResolvedValue(
      {
        items: [
          sampleDocumentView,
          {
            ...sampleDocumentView,
            id: 9,
            fileName: "pan_card_1_1719000000000.pdf",
          },
        ],
        total: 2,
        page: 1,
        pageSize: 10,
      },
    );

    const res = await request(app).get("/bidders/1/documents/history");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].createdAt).toBeDefined();
    expect(res.body.items[0].createdByName).toBe("Admin");
  });

  it("returns 404 when bidder is missing", async () => {
    vi.mocked(bidderDocumentsService.listBidderDocumentHistory).mockRejectedValue(
      new (await import("../services/bidders.service.js")).BidderNotFoundError(),
    );

    const res = await request(app).get("/bidders/999/documents/history");

    expect(res.status).toBe(404);
  });
});

describe("PUT /bidders/:id/documents", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when documentTypeId is missing", async () => {
    const res = await request(app)
      .put("/bidders/1/documents")
      .attach("file", Buffer.from("%PDF-1.4"), "pan.pdf");

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.documentTypeId).toBeDefined();
  });

  it("returns 400 when file is missing", async () => {
    const res = await request(app)
      .put("/bidders/1/documents")
      .field("documentTypeId", "1");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      BiddersValidationMessages.DOCUMENT_FILE_REQUIRED,
    );
  });

  it("returns 404 when bidder is missing", async () => {
    vi.mocked(bidderDocumentsService.uploadBidderDocument).mockRejectedValue(
      new (await import("../services/bidders.service.js")).BidderNotFoundError(),
    );

    const res = await request(app)
      .put("/bidders/999/documents")
      .field("documentTypeId", "1")
      .attach("file", Buffer.from("%PDF-1.4"), "pan.pdf");

    expect(res.status).toBe(404);
  });

  it("returns 400 when cancelled cheque document type is used", async () => {
    vi.mocked(bidderDocumentsService.uploadBidderDocument).mockRejectedValue(
      new bidderDocumentsService.BidderDocumentTypeNotFoundError(),
    );

    const res = await request(app)
      .put("/bidders/1/documents")
      .field("documentTypeId", "4")
      .attach("file", Buffer.from("%PDF-1.4"), "cheque.pdf");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(BiddersErrorMessages.DOCUMENT_TYPE_NOT_FOUND);
  });
});

describe("GET /bidders/options", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns options and forwards search params including clientId", async () => {
    const options = [{ bidderId: 12, companyName: "Acme Bidder" }];
    const list = vi
      .spyOn(biddersService, "listActiveBidderOptions")
      .mockResolvedValue(options);

    const res = await request(app).get(
      "/bidders/options?q=12&limit=50&ids=12&clientId=3",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ options });
    expect(list).toHaveBeenCalledWith({
      q: "12",
      limit: 50,
      ids: [12],
      clientId: 3,
    });
  });

  it("omits clientId when not provided", async () => {
    const list = vi
      .spyOn(biddersService, "listActiveBidderOptions")
      .mockResolvedValue([]);

    const res = await request(app).get("/bidders/options?q=acme");

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      q: "acme",
      limit: undefined,
      ids: [],
      clientId: undefined,
    });
  });
});

describe("GET /bidders/options/ids", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards q and clientId to listActiveBidderOptionIds", async () => {
    const result = { ids: [1, 2], total: 2, truncated: false };
    const listIds = vi
      .spyOn(biddersService, "listActiveBidderOptionIds")
      .mockResolvedValue(result);

    const res = await request(app).get(
      "/bidders/options/ids?q=99&clientId=4",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(listIds).toHaveBeenCalledWith({ q: "99", clientId: 4 });
  });
});

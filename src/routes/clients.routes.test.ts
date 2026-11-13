import {
  ClientsErrorMessages,
  ClientsValidationMessages,
} from "@auctionit/messages/clients";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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

vi.mock("../services/client-documents.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/client-documents.service.js")
    >();
  return {
    ...actual,
    listActiveClientDocumentTypes: vi.fn(),
    listClientDocuments: vi.fn(),
    listClientDocumentHistory: vi.fn(),
    uploadClientDocument: vi.fn(),
  };
});

const { createApp } = await import("../app.js");
const { clientsService } = await import("../services/clients.service.js");
const clientDocumentsService =
  await import("../services/client-documents.service.js");

const validCompanyInfo = {
  address: "123 Industrial Area",
  locationId: 1,
  pincode: "560001",
  phone: "9876543210",
  email: "contact@company.com",
  pan: "ABCDE1234F",
  gstin: "07ABCDE1234F1Z5",
};

const validPlantLocation = {
  name: "Plant 1",
  locationId: 1,
  kamId: 1,
  pincode: "560001",
  gstin: "07ABCDE1234F1Z5",
  pan: "ABCDE1234F",
  pocName: "John Doe",
  pocEmail: "john@example.com",
  pocPhone: "9876543210",
  billingName: "Billing Contact",
  billingEmailTo: "billing@example.com",
};

const validServiceFee = {
  serviceFeeType: "service_percentage" as const,
  serviceFeeValue: 0.5,
};

describe("POST /clients", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it("returns 400 with fieldErrors for invalid company PAN", async () => {
    const res = await request(app)
      .post("/clients")
      .send({
        companyName: "Acme Corp",
        ...validServiceFee,
        companyInfo: {
          ...validCompanyInfo,
          pan: "INVALID",
        },
        plantLocations: [validPlantLocation],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ClientsValidationMessages.VALIDATION_FAILED);
    expect(res.body.fieldErrors["companyInfo.pan"]).toEqual([
      ClientsValidationMessages.INVALID_PAN,
    ]);
  });

  it("returns 400 with fieldErrors when company location is missing", async () => {
    const res = await request(app)
      .post("/clients")
      .send({
        companyName: "Acme Corp",
        ...validServiceFee,
        companyInfo: {
          ...validCompanyInfo,
          locationId: null,
        },
        plantLocations: [validPlantLocation],
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors["companyInfo.locationId"]).toContain(
      ClientsValidationMessages.LOCATION_REQUIRED,
    );
  });

  it("returns 400 when no plant locations are provided", async () => {
    const res = await request(app)
      .post("/clients")
      .send({
        companyName: "Acme Corp",
        ...validServiceFee,
        companyInfo: validCompanyInfo,
        plantLocations: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.plantLocations).toContain(
      ClientsValidationMessages.PLANT_LOCATION_REQUIRED,
    );
  });

  it("returns 400 with fieldErrors for invalid plant poc email and phone", async () => {
    const res = await request(app)
      .post("/clients")
      .send({
        companyName: "Acme Corp",
        ...validServiceFee,
        companyInfo: validCompanyInfo,
        plantLocations: [
          {
            ...validPlantLocation,
            pocEmail: "john@example.com, not-an-email",
            pocPhone: "9876543210, abc",
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors["plantLocations.0.pocEmail"]).toContain(
      ClientsValidationMessages.INVALID_EMAIL,
    );
    expect(res.body.fieldErrors["plantLocations.0.pocPhone"]).toContain(
      ClientsValidationMessages.INVALID_PHONE,
    );
  });
});

describe("GET /clients", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns paginated clients with server-side params", async () => {
    const result = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      counts: { total: 0, active: 0, inactive: 0 },
    };
    const list = vi.spyOn(clientsService, "list").mockResolvedValue(result);

    const res = await request(app).get(
      "/clients?page=1&pageSize=10&search=globex&status=inactive&sortBy=serviceFeeValue&sortOrder=desc",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 10,
        search: "globex",
        status: "inactive",
        sortBy: "serviceFeeValue",
        sortOrder: "desc",
      }),
    );
  });
});

describe("GET /clients/document-types", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.mocked(
      clientDocumentsService.listActiveClientDocumentTypes,
    ).mockResolvedValue([
      {
        documentTypeId: 1,
        name: "Agreement",
        fileNamePrefix: "agreement_",
        allowedExtensions: [
          "jpg",
          "jpeg",
          "png",
          "webp",
          "pdf",
          "doc",
          "docx",
          "xls",
          "xlsx",
        ],
        maxBytes: 10 * 1024 * 1024,
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns active document types and allowed extensions", async () => {
    const res = await request(app).get("/clients/document-types");

    expect(res.status).toBe(200);
    expect(res.body.documentTypes).toHaveLength(1);
    expect(res.body.allowedExtensions).toContain("pdf");
    expect(res.body.allowedExtensions).not.toContain("mp4");
  });
});

const sampleDocumentView = {
  id: 10,
  documentTypeId: 1,
  documentTypeName: "Agreement",
  fileName: "agreement_1_1719398400123.pdf",
  previewUrl: "https://signed.example/agreement.pdf",
  createdAt: "2024-06-26T10:00:00.000Z",
  createdBy: 1,
  createdByName: "Admin",
};

describe("GET /clients/:id/documents", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns latest documents per type with audit fields", async () => {
    vi.mocked(clientDocumentsService.listClientDocuments).mockResolvedValue({
      items: [sampleDocumentView],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    const res = await request(app).get("/clients/1/documents");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      documentTypeName: "Agreement",
      createdByName: "Admin",
    });
  });

  it("returns 404 when client is missing", async () => {
    vi.mocked(clientDocumentsService.listClientDocuments).mockRejectedValue(
      new (
        await import("../services/clients.service.js")
      ).ClientNotFoundError(),
    );

    const res = await request(app).get("/clients/999/documents");

    expect(res.status).toBe(404);
  });
});

describe("GET /clients/:id/documents/history", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns full upload history with audit fields", async () => {
    vi.mocked(
      clientDocumentsService.listClientDocumentHistory,
    ).mockResolvedValue({
      items: [
        sampleDocumentView,
        {
          ...sampleDocumentView,
          id: 9,
          fileName: "agreement_1_1719000000000.pdf",
        },
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });

    const res = await request(app).get("/clients/1/documents/history");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].createdAt).toBeDefined();
    expect(res.body.items[0].createdByName).toBe("Admin");
  });

  it("returns 404 when client is missing", async () => {
    vi.mocked(
      clientDocumentsService.listClientDocumentHistory,
    ).mockRejectedValue(
      new (
        await import("../services/clients.service.js")
      ).ClientNotFoundError(),
    );

    const res = await request(app).get("/clients/999/documents/history");

    expect(res.status).toBe(404);
  });
});

describe("PUT /clients/:id/documents", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when documentTypeId is missing", async () => {
    const res = await request(app)
      .put("/clients/1/documents")
      .attach("file", Buffer.from("%PDF-1.4"), "agreement.pdf");

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.documentTypeId).toBeDefined();
  });

  it("returns 400 when file is missing", async () => {
    const res = await request(app)
      .put("/clients/1/documents")
      .field("documentTypeId", "1");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      ClientsValidationMessages.DOCUMENT_FILE_REQUIRED,
    );
  });

  it("returns 404 when client is missing", async () => {
    vi.mocked(clientDocumentsService.uploadClientDocument).mockRejectedValue(
      new (
        await import("../services/clients.service.js")
      ).ClientNotFoundError(),
    );

    const res = await request(app)
      .put("/clients/999/documents")
      .field("documentTypeId", "1")
      .attach("file", Buffer.from("%PDF-1.4"), "agreement.pdf");

    expect(res.status).toBe(404);
  });

  it("returns TnC validation message when type-2 file is invalid", async () => {
    vi.mocked(clientDocumentsService.uploadClientDocument).mockRejectedValue(
      new clientDocumentsService.ClientDocumentFileInvalidError(
        "TNC_INVALID_EXTENSION",
      ),
    );

    const res = await request(app)
      .put("/clients/1/documents")
      .field("documentTypeId", "2")
      .attach("file", Buffer.from("not-a-pdf"), "terms.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      ClientsValidationMessages.DOCUMENT_TNC_FILE_INVALID,
    );
  });

  it("returns TnC size message when type-2 file is too large", async () => {
    vi.mocked(clientDocumentsService.uploadClientDocument).mockRejectedValue(
      new clientDocumentsService.ClientDocumentFileInvalidError(
        "TNC_INVALID_SIZE",
      ),
    );

    const res = await request(app)
      .put("/clients/1/documents")
      .field("documentTypeId", "2")
      .attach("file", Buffer.from("%PDF-1.4"), "terms.pdf");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      ClientsValidationMessages.DOCUMENT_TNC_FILE_TOO_LARGE,
    );
  });
});

const validAuctionSettings = {
  auctionPrefix: "TEST/",
  serviceFeeType: "service_percentage" as const,
  serviceFeeValue: 0.5,
  isLastBidExtension: false,
  lastBidExtensionWindow: 0,
  lastBidExtensionInterval: 0,
  lastBidExtensionCountMax: 0,
  isStaggered: false,
  staggerInterval: 0,
};

describe("PATCH /clients/:id/auction-settings", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when the client has a live auction", async () => {
    vi.spyOn(clientsService, "updateAuctionSettings").mockRejectedValue(
      new (
        await import("../services/clients.service.js")
      ).ClientLiveAuctionError(),
    );

    const res = await request(app)
      .patch("/clients/1/auction-settings")
      .send(validAuctionSettings);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      ClientsErrorMessages.AUCTION_SETTINGS_EDIT_REQUIRES_NO_LIVE,
    );
  });
});

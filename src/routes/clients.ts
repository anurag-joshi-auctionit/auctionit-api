import { Router, type NextFunction, type Response } from "express";
import {
  ClientsErrorMessages,
  ClientsValidationMessages,
} from "@auctionit/messages/clients";
import { UsersErrorMessages } from "@auctionit/messages/users";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../auth/middleware.js";
import {
  additionalFieldBodySchema,
  additionalFieldStatusSchema,
  auctionSettingsSchema,
  clientsListQuerySchema,
  companyInfoUpdateSchema,
  createClientSchema,
  clientDocumentUploadFieldsSchema,
  clientDocumentsListQuerySchema,
  mappedBiddersListQuerySchema,
  KamUserNotFoundError,
  materialLocationBodySchema,
  plantLocationBodySchema,
} from "../lib/clients/schemas.js";
import {
  createEntityUserSchema,
  entityUsersListQuerySchema,
  updateEntityUserSchema,
} from "../lib/users/schemas.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import { entityOptionsQuerySchema, entityOptionIdsQuerySchema } from "../lib/options-query.js";
import { clientUsersService, UserError } from "../services/users.service.js";
import {
  ClientLiveAuctionError,
  ClientLocationNotFoundError,
  ClientNotFoundError,
  clientsService,
  LastPlantLocationError,
} from "../services/clients.service.js";
import {
  ClientDocumentFileInvalidError,
  ClientDocumentTypeNotFoundError,
  listActiveClientDocumentTypes,
  listClientDocumentAllowedExtensions,
  listClientDocumentHistory,
  listClientDocuments,
  MAX_CLIENT_DOCUMENT_BYTES,
  uploadClientDocument,
} from "../services/client-documents.service.js";
import {
  createMemoryUpload,
  singleMemoryUpload,
} from "../lib/import/index.js";
import {
  AdditionalFieldNotFoundError,
  AdditionalFieldValidationError,
  clientAdditionalFieldsService,
} from "../services/client-additional-fields.service.js";

const router = Router();

const CLIENT_READERS = ["module.clients", "clients.read"];

/** Client pickers are also used by the Accounts role to filter EMD forfeitures and accounts-facing service invoices. */
const CLIENT_OPTION_READERS = [
  ...CLIENT_READERS,
  "emd.forfeitures.read",
  "emd.forfeitures.pay",
  "service-invoices.read",
  "service-invoices.accounts-edit",
];

router.get(
  "/options",
  requireAuth,
  requireAnyPermission(CLIENT_OPTION_READERS),
  async (req, res, next) => {
    const parsed = entityOptionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    try {
      const options = await clientsService.listActiveClientOptions({
        q: parsed.data.q,
        limit: parsed.data.limit,
        ids: parsed.data.ids,
      });
      res.json({ options });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/options/ids",
  requireAuth,
  requireAnyPermission(CLIENT_OPTION_READERS),
  async (req, res, next) => {
    const parsed = entityOptionIdsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    try {
      const result = await clientsService.listActiveClientOptionIds({
        q: parsed.data.q,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

router.use(requireAuth, requireAnyPermission(CLIENT_READERS));

const clientDocumentUpload = createMemoryUpload({
  maxBytes: MAX_CLIENT_DOCUMENT_BYTES,
});

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleClientError(
  err: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof ClientNotFoundError) {
    res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
    return;
  }
  if (err instanceof KamUserNotFoundError) {
    res
      .status(400)
      .json(
        fieldValidationErrorBody(
          { kamId: [ClientsErrorMessages.KAM_USER_NOT_FOUND] },
          ClientsErrorMessages.KAM_USER_NOT_FOUND,
        ),
      );
    return;
  }
  if (err instanceof ClientLiveAuctionError) {
    res.status(400).json({
      error: ClientsErrorMessages.AUCTION_SETTINGS_EDIT_REQUIRES_NO_LIVE,
    });
    return;
  }
  next(err);
}

function handleClientLocationError(
  err: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof ClientLocationNotFoundError) {
    res.status(404).json({ error: ClientsErrorMessages.LOCATION_NOT_FOUND });
    return;
  }
  if (err instanceof LastPlantLocationError) {
    res
      .status(400)
      .json(
        fieldValidationErrorBody(
          { isActive: [ClientsErrorMessages.LAST_PLANT_LOCATION_REQUIRED] },
          ClientsErrorMessages.LAST_PLANT_LOCATION_REQUIRED,
        ),
      );
    return;
  }
  handleClientError(err, res, next);
}

function handleUserError(
  err: unknown,
  res: Response,
  next: NextFunction,
  entityNotFoundMessage: string,
): void {
  if (err instanceof UserError) {
    switch (err.code) {
      case "ENTITY_NOT_FOUND":
        res.status(404).json({ error: entityNotFoundMessage });
        return;
      case "USER_NOT_FOUND":
        res.status(404).json({ error: UsersErrorMessages.USER_NOT_FOUND });
        return;
      case "LOGIN_TAKEN":
        res
          .status(409)
          .json(
            fieldValidationErrorBody(
              { userLoginName: [err.message] },
              err.message,
            ),
          );
        return;
      case "BIDDER_USER_EXISTS":
        res.status(409).json({ error: err.message });
        return;
      case "OTP_MISSING_EMAIL":
      case "OTP_DELIVERY_FAILED":
        res.status(400).json({ error: err.message, code: err.code });
        return;
      default:
        break;
    }
  }
  next(err);
}

function notMigrated(_req: import("express").Request, res: Response) {
  res.status(501).json({ error: ClientsErrorMessages.NOT_MIGRATED });
}

router.get("/", async (req, res, next) => {
  const parsed = clientsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientsService.list(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/stats", async (_req, res, next) => {
  try {
    const counts = await clientsService.getCounts();
    res.json(counts);
  } catch (e) {
    next(e);
  }
});

router.get("/kam-users", async (_req, res, next) => {
  try {
    const users = await clientsService.listKamUsers();
    res.json({ users });
  } catch (e) {
    next(e);
  }
});

router.get("/document-types", async (_req, res, next) => {
  try {
    const documentTypes = await listActiveClientDocumentTypes();
    res.json({
      documentTypes,
      allowedExtensions: listClientDocumentAllowedExtensions(),
    });
  } catch (e) {
    next(e);
  }
});

router.get("/:id/picker-context", async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  try {
    const ctx = await clientsService.getRegionPlantPickerData(clientId);
    if (!ctx) {
      res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
      return;
    }
    res.json(ctx);
  } catch (e) {
    next(e);
  }
});

router.post("/", requirePermission("client.add"), async (req, res, next) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientsService.create(parsed.data, req.user!.id);
    res.status(201).json(result);
  } catch (e) {
    handleClientError(e, res, next);
  }
});

router.get("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  try {
    const client = await clientsService.get(id);
    if (!client) {
      res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
      return;
    }
    res.json({ client });
  } catch (e) {
    next(e);
  }
});

router.get("/:id/mapped-bidders", async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = mappedBiddersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientsService.listMappedBidders(clientId, parsed.data);
    res.json(result);
  } catch (e) {
    if (e instanceof ClientNotFoundError) {
      res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
      return;
    }
    next(e);
  }
});

router.get("/:id/documents/history", async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = clientDocumentsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await listClientDocumentHistory(clientId, parsed.data);
    res.json(result);
  } catch (e) {
    if (e instanceof ClientNotFoundError) {
      res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
      return;
    }
    next(e);
  }
});

router.get("/:id/documents", async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = clientDocumentsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await listClientDocuments(clientId, parsed.data);
    res.json(result);
  } catch (e) {
    if (e instanceof ClientNotFoundError) {
      res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
      return;
    }
    next(e);
  }
});

router.put(
  "/:id/documents",
  requirePermission("client.write"),
  singleMemoryUpload(
    clientDocumentUpload,
    "file",
    ClientsValidationMessages.DOCUMENT_FILE_TOO_LARGE,
  ),
  async (req, res, next) => {
    const clientId = parseId(req.params.id);
    if (clientId === null) {
      res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
      return;
    }
    const fields = clientDocumentUploadFieldsSchema.safeParse(req.body);
    if (!fields.success) {
      res.status(400).json(zodValidationErrorBody(fields.error));
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: ClientsValidationMessages.DOCUMENT_FILE_REQUIRED,
      });
      return;
    }
    if (!file.buffer.length) {
      res.status(400).json({
        error: ClientsErrorMessages.INVALID_DOCUMENT_FILE,
      });
      return;
    }

    try {
      const document = await uploadClientDocument({
        clientId,
        documentTypeId: fields.data.documentTypeId,
        buffer: file.buffer,
        originalFileName: file.originalname,
        userId: req.user!.id,
      });
      res.json({ document });
    } catch (e) {
      if (e instanceof ClientNotFoundError) {
        res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
        return;
      }
      if (e instanceof ClientDocumentTypeNotFoundError) {
        res
          .status(400)
          .json({ error: ClientsErrorMessages.DOCUMENT_TYPE_NOT_FOUND });
        return;
      }
      if (e instanceof ClientDocumentFileInvalidError) {
        const message =
          e.message === "TNC_INVALID_SIZE"
            ? ClientsValidationMessages.DOCUMENT_TNC_FILE_TOO_LARGE
            : e.message === "TNC_INVALID_EXTENSION"
              ? ClientsValidationMessages.DOCUMENT_TNC_FILE_INVALID
              : e.message === "INVALID_SIZE"
                ? ClientsValidationMessages.DOCUMENT_FILE_TOO_LARGE
                : ClientsValidationMessages.DOCUMENT_FILE_INVALID;
        res.status(400).json({ error: message });
        return;
      }
      const errMessage = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMessage || "Upload failed" });
    }
  },
);

router.patch("/:id/company-info", requirePermission("client.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = companyInfoUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await clientsService.updateCompanyInfo(clientId, parsed.data, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    handleClientError(e, res, next);
  }
});

router.patch("/:id/auction-settings", requirePermission("client.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = auctionSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await clientsService.updateAuctionSettings(
      clientId,
      parsed.data,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    handleClientError(e, res, next);
  }
});

function handleAdditionalFieldError(
  err: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof AdditionalFieldNotFoundError) {
    res
      .status(404)
      .json({ error: ClientsErrorMessages.ADDITIONAL_FIELD_NOT_FOUND });
    return;
  }
  if (err instanceof AdditionalFieldValidationError) {
    res
      .status(400)
      .json(fieldValidationErrorBody({ [err.field]: [err.message] }, err.message));
    return;
  }
  handleClientError(err, res, next);
}

router.get("/:id/additional-fields", async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  try {
    const fields = await clientAdditionalFieldsService.list(clientId);
    res.json({ fields });
  } catch (e) {
    handleAdditionalFieldError(e, res, next);
  }
});

router.post("/:id/additional-fields", requirePermission("client.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = additionalFieldBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientAdditionalFieldsService.create(
      clientId,
      parsed.data,
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (e) {
    handleAdditionalFieldError(e, res, next);
  }
});

router.patch("/:id/additional-fields/:fieldId", requirePermission("client.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  const fieldId = parseId(req.params.fieldId);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  if (fieldId === null) {
    res
      .status(400)
      .json({ error: ClientsErrorMessages.INVALID_ADDITIONAL_FIELD_ID });
    return;
  }
  const parsed = additionalFieldBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await clientAdditionalFieldsService.update(
      clientId,
      fieldId,
      parsed.data,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    handleAdditionalFieldError(e, res, next);
  }
});

router.patch(
  "/:id/additional-fields/:fieldId/status",
  requirePermission("client.write"),
  async (req, res, next) => {
    const clientId = parseId(req.params.id);
    const fieldId = parseId(req.params.fieldId);
    if (clientId === null) {
      res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
      return;
    }
    if (fieldId === null) {
      res
        .status(400)
        .json({ error: ClientsErrorMessages.INVALID_ADDITIONAL_FIELD_ID });
      return;
    }
    const parsed = additionalFieldStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    try {
      await clientAdditionalFieldsService.setActive(
        clientId,
        fieldId,
        parsed.data.isActive,
        req.user!.id,
      );
      res.json({ ok: true });
    } catch (e) {
      handleAdditionalFieldError(e, res, next);
    }
  },
);

router.post("/:id/regions", requirePermission("client.write"), notMigrated);
router.patch("/:id/regions/:regionId", requirePermission("client.write"), notMigrated);
router.post("/:id/contacts", requirePermission("client.write"), notMigrated);

router.get("/:id/users", async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = entityUsersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientUsersService.listForClient(
      clientId,
      parsed.data,
    );
    res.json(result);
  } catch (e) {
    handleUserError(e, res, next, ClientsErrorMessages.CLIENT_NOT_FOUND);
  }
});

router.post("/:id/users", requirePermission("client.users.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = createEntityUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientUsersService.createForClient(
      clientId,
      parsed.data,
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (e) {
    handleUserError(e, res, next, ClientsErrorMessages.CLIENT_NOT_FOUND);
  }
});

router.patch("/:id/users/:userId", requirePermission("client.users.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (clientId === null || userId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = updateEntityUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await clientUsersService.updateForClient(
      clientId,
      userId,
      parsed.data,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    handleUserError(e, res, next, ClientsErrorMessages.CLIENT_NOT_FOUND);
  }
});

router.post("/:id/users/:userId/reset-password", requirePermission("client.users.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (clientId === null || userId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  try {
    await clientUsersService.resetPasswordForClient(
      clientId,
      userId,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    handleUserError(e, res, next, ClientsErrorMessages.CLIENT_NOT_FOUND);
  }
});

router.post("/:id/plant-locations", requirePermission("client.plants.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = plantLocationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientsService.createPlantLocation(
      clientId,
      parsed.data,
      req.user!.id,
    );
    if (!result) {
      res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
      return;
    }
    res.status(201).json(result);
  } catch (e) {
    handleClientError(e, res, next);
  }
});

router.patch("/:id/plant-locations/:locationId", requirePermission("client.plants.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  const locationId = parseId(req.params.locationId);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  if (locationId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_LOCATION_ID });
    return;
  }
  const parsed = plantLocationBodySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await clientsService.updatePlantLocation(
      clientId,
      locationId,
      parsed.data,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    handleClientLocationError(e, res, next);
  }
});

router.post("/:id/material-locations", requirePermission("client.plants.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  const parsed = materialLocationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await clientsService.createMaterialLocation(
      clientId,
      parsed.data,
      req.user!.id,
    );
    if (!result) {
      res.status(404).json({ error: ClientsErrorMessages.CLIENT_NOT_FOUND });
      return;
    }
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/material-locations/:locationId", requirePermission("client.plants.write"), async (req, res, next) => {
  const clientId = parseId(req.params.id);
  const locationId = parseId(req.params.locationId);
  if (clientId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  if (locationId === null) {
    res.status(400).json({ error: ClientsErrorMessages.INVALID_LOCATION_ID });
    return;
  }
  const parsed = materialLocationBodySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await clientsService.updateMaterialLocation(
      clientId,
      locationId,
      parsed.data,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    handleClientLocationError(e, res, next);
  }
});

export default router;

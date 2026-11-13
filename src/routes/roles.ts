import { Router } from "express";
import {
  RolesErrorMessages,
  RolesValidationMessages,
} from "@auctionit/messages/roles";
import {
  PermissionsErrorMessages,
  PermissionsValidationMessages,
} from "@auctionit/messages/permissions";
import {
  requireAuth,
  requireRolesMaster,
} from "../auth/middleware.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import {
  createRoleSchema,
  patchRoleSchema,
  putRolePermissionsSchema,
} from "../lib/roles/schemas.js";
import {
  RolesServiceError,
  rolesService,
} from "../services/roles.service.js";

const router = Router();

router.use(requireAuth, requireRolesMaster);

function parseRoleId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

router.get("/", async (req, res, next) => {
  try {
    const items = await rolesService.list();
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          RolesValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }
  try {
    const created = await rolesService.create(parsed.data, req.user?.id);
    res.status(201).json({ role: created });
  } catch (e) {
    if (e instanceof RolesServiceError) {
      if (e.code === "conflict") {
        res.status(409).json(
          fieldValidationErrorBody(
            { code: [RolesValidationMessages.CODE_EXISTS] },
            RolesValidationMessages.CODE_EXISTS,
          ),
        );
        return;
      }
      if (e.code === "validation") {
        res.status(400).json(
          fieldValidationErrorBody(
            { code: [e.message] },
            RolesValidationMessages.VALIDATION_FAILED,
          ),
        );
        return;
      }
      res.status(404).json({
        error: RolesErrorMessages.ROLE_NOT_FOUND,
        code: e.code,
      });
      return;
    }
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseRoleId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: RolesValidationMessages.INVALID_ROLE_ID });
    return;
  }
  const parsed = patchRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          RolesValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }
  try {
    const role = await rolesService.update(id, parsed.data, req.user?.id);
    res.json({ role });
  } catch (e) {
    if (e instanceof RolesServiceError) {
      const status = e.code === "not_found" ? 404 : 400;
      res.status(status).json({
        error:
          e.code === "not_found"
            ? RolesErrorMessages.ROLE_NOT_FOUND
            : e.message,
        code: e.code,
      });
      return;
    }
    next(e);
  }
});

router.get("/:id/permissions", async (req, res, next) => {
  const id = parseRoleId(req.params.id);
  if (id == null) {
    res
      .status(400)
      .json({ error: PermissionsValidationMessages.INVALID_ROLE_ID });
    return;
  }
  try {
    const data = await rolesService.getRolePermissions(id);
    res.json(data);
  } catch (e) {
    if (e instanceof RolesServiceError) {
      res.status(404).json({
        error: PermissionsErrorMessages.ROLE_NOT_FOUND,
        code: e.code,
      });
      return;
    }
    next(e);
  }
});

router.put("/:id/permissions", async (req, res, next) => {
  const id = parseRoleId(req.params.id);
  if (id == null) {
    res
      .status(400)
      .json({ error: PermissionsValidationMessages.INVALID_ROLE_ID });
    return;
  }
  const parsed = putRolePermissionsSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          PermissionsValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }
  try {
    const data = await rolesService.setRolePermissions(
      id,
      parsed.data.permissions,
      req.user?.id,
    );
    res.json(data);
  } catch (e) {
    if (e instanceof RolesServiceError) {
      if (e.code === "validation") {
        res.status(400).json({
          error: e.message,
          code: e.code,
        });
        return;
      }
      const status = e.code === "not_found" ? 404 : 400;
      res.status(status).json({
        error:
          e.code === "not_found"
            ? PermissionsErrorMessages.ROLE_NOT_FOUND
            : PermissionsErrorMessages.SAVE_FAILED,
        code: e.code,
      });
      return;
    }
    next(e);
  }
});

export default router;

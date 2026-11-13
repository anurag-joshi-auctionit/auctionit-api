import {
  UsersErrorMessages,
  UsersValidationMessages,
} from "@auctionit/messages/users";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import { UserError, usersService } from "../services/users.service.js";
import {
  createStaffUserSchema,
  staffListQuerySchema,
  updateStaffUserSchema,
} from "../lib/users/schemas.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";

const router = Router();
router.use(requireAuth, requireAnyPermission(["module.users", "users.read"]));

router.get("/", async (req, res, next) => {
  const parsed = staffListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    res.json(await usersService.list(parsed.data));
  } catch (e) {
    next(e);
  }
});

router.get("/role-options", async (req, res, next) => {
  try {
    const scope = typeof req.query.scope === "string" ? req.query.scope : "staff";
    const items =
      scope === "all"
        ? await usersService.listRoleFilterOptions()
        : scope === "create"
          ? await usersService.listCreatableRoleOptions()
          : await usersService.listStaffRoleOptions();
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

function parseUserId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get("/:userId", async (req, res, next) => {
  const userId = parseUserId(req.params.userId);
  if (userId === null) {
    res.status(400).json({ error: UsersErrorMessages.INVALID_USER_ID });
    return;
  }
  try {
    const user = await usersService.get(userId);
    if (!user) {
      res.status(404).json({ error: UsersErrorMessages.USER_NOT_FOUND });
      return;
    }
    res.json(user);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createStaffUserSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const newUserId = await usersService.create(parsed.data, req.user!.id);
    res.status(201).json({ userId: newUserId });
  } catch (e) {
    if (e instanceof UserError) {
      if (e.code === "LOGIN_TAKEN") {
        res.status(409).json({ error: UsersErrorMessages.LOGIN_TAKEN });
        return;
      }
      if (e.code === "BIDDER_USER_EXISTS") {
        res.status(409).json({ error: UsersErrorMessages.BIDDER_USER_EXISTS });
        return;
      }
      if (e.code === "LOGIN_REQUIRED") {
        res.status(400).json({ error: UsersValidationMessages.USERNAME_REQUIRED });
        return;
      }
      if (e.code === "ROLE_NOT_FOUND") {
        res.status(400).json({ error: e.message });
        return;
      }
      if (e.code === "ENTITY_NOT_FOUND") {
        res.status(400).json({ error: e.message });
        return;
      }
      if (
        e.code === "OTP_MISSING_EMAIL" ||
        e.code === "OTP_DELIVERY_FAILED"
      ) {
        res.status(400).json({ error: e.message, code: e.code });
        return;
      }
    }
    next(e);
  }
});

router.put("/:userId", async (req, res, next) => {
  const userId = parseUserId(req.params.userId);
  if (userId === null) {
    res.status(400).json({ error: UsersErrorMessages.INVALID_USER_ID });
    return;
  }
  const parsed = updateStaffUserSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const ok = await usersService.update(userId, parsed.data, req.user!.id);
    if (!ok) {
      res.status(404).json({ error: UsersErrorMessages.USER_NOT_FOUND });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof UserError) {
      if (e.code === "LOGIN_TAKEN") {
        res.status(409).json({ error: UsersErrorMessages.LOGIN_TAKEN });
        return;
      }
      if (e.code === "ROLE_NOT_FOUND") {
        res.status(400).json({ error: e.message });
        return;
      }
      if (e.code === "BIDDER_USER_EXISTS") {
        res.status(409).json({ error: UsersErrorMessages.BIDDER_USER_EXISTS });
        return;
      }
      if (e.code === "ENTITY_NOT_FOUND") {
        res.status(400).json({ error: e.message });
        return;
      }
    }
    next(e);
  }
});

const activateBodySchema = z.object({ isActive: z.boolean() });

router.post("/:userId/set-active", async (req, res, next) => {
  const userId = parseUserId(req.params.userId);
  if (userId === null) {
    res.status(400).json({ error: UsersErrorMessages.INVALID_USER_ID });
    return;
  }
  const parsed = activateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const ok = await usersService.setActive(userId, parsed.data.isActive, req.user!.id);
    if (!ok) {
      res.status(404).json({ error: UsersErrorMessages.USER_NOT_FOUND });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/:userId/reset-password", async (req, res, next) => {
  const userId = parseUserId(req.params.userId);
  if (userId === null) {
    res.status(400).json({ error: UsersErrorMessages.INVALID_USER_ID });
    return;
  }
  try {
    const ok = await usersService.resetPassword(userId, req.user!.id);
    if (!ok) {
      res.status(404).json({ error: UsersErrorMessages.USER_NOT_FOUND });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof UserError) {
      if (
        e.code === "OTP_MISSING_EMAIL" ||
        e.code === "OTP_DELIVERY_FAILED"
      ) {
        res.status(400).json({ error: e.message, code: e.code });
        return;
      }
    }
    next(e);
  }
});

export default router;

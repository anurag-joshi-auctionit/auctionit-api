import { z } from "zod";
import {
  createStaffUserSchema,
  staffListQuerySchema,
  updateStaffUserSchema,
} from "../../lib/users/schemas.js";
import { ErrorBody, OkBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  UserCreated,
  UserCredentialsErrorBody,
  UserDetail,
  UserList,
  UserRoleOptions,
} from "../responses/users.js";

// Docs for src/routes/users.ts — see docs/api/README.md.
const r = documentRouter("/users");

const notFound = { description: "User not found.", schema: ErrorBody };
const invalidIdOrBody = {
  description: "Invalid `userId`, or body validation failed.",
  schema: z.union([ValidationErrorBody, ErrorBody]),
};

r.get("/", {
  summary: "List users",
  description:
    "Paginated user directory across all roles (staff and portal). `search` matches name, username or email; " +
    "`role` filters by role code; `clientId` / `bidderId` filter by active client membership / linked bidder. " +
    "Includes counts for the status tabs.",
  query: staffListQuerySchema,
  responses: { 200: UserList },
});

r.get("/role-options", {
  summary: "Role options for user forms",
  description:
    "`scope=staff` (default, also used for unknown values): admin-app staff roles. `scope=create`: staff roles plus " +
    "the client/bidder portal roles assignable from New User. `scope=all`: every role (directory filter).",
  query: z.object({ scope: z.enum(["staff", "create", "all"]).optional() }),
  responses: { 200: UserRoleOptions },
});

r.get("/:userId", {
  summary: "Get user",
  responses: {
    200: UserDetail,
    400: { description: "Invalid `userId`.", schema: ErrorBody },
    404: notFound,
  },
});

r.post("/", {
  summary: "Create user",
  description:
    "Creates a user with the given role and optional bidder link / client memberships. The account gets an unusable " +
    "random password and **no email is sent** — use `POST /users/{userId}/reset-password` to email credentials.",
  body: createStaffUserSchema,
  responses: {
    201: { description: "Created.", schema: UserCreated },
    400: {
      description: "Validation error, unknown/non-assignable role, or a referenced bidder/client does not exist.",
      schema: z.union([ValidationErrorBody, ErrorBody]),
    },
    409: { description: "Username already taken, or the bidder already has a login user.", schema: ErrorBody },
  },
});

r.put("/:userId", {
  summary: "Update user",
  description:
    "Replaces profile fields and role. `bidderId`: omit to keep, `null` to unlink. `clientIds`: omit to keep, " +
    "otherwise the user's client memberships are synced to this list. Username and active flag are not changed here.",
  body: updateStaffUserSchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid `userId`, validation error, unknown role, or a referenced bidder/client does not exist.", schema: z.union([ValidationErrorBody, ErrorBody]) },
    404: notFound,
    409: { description: "The bidder already has a login user.", schema: ErrorBody },
  },
});

r.post("/:userId/set-active", {
  summary: "Activate / deactivate user",
  description: "Inactive users cannot log in, and their existing session stops working immediately.",
  body: z.object({ isActive: z.boolean() }),
  responses: { 200: OkBody, 400: invalidIdOrBody, 404: notFound },
});

r.post("/:userId/reset-password", {
  summary: "Reset password and email credentials",
  description:
    "Generates a temporary password, ends the user's session and **emails** the new credentials. The user must change " +
    "the password after logging in.",
  responses: {
    200: OkBody,
    400: {
      description: "Invalid `userId`, or `OTP_MISSING_EMAIL` (user has no email) / `OTP_DELIVERY_FAILED` (email could not be sent).",
      schema: z.union([ErrorBody, UserCredentialsErrorBody]),
    },
    404: notFound,
  },
});

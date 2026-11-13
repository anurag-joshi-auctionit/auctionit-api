import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors StaffRoleOption / UserListItem / UserListResult / UserDetail in
// services/users.service.ts.

export const UserRoleOptions = z
  .object({
    items: z.array(
      z.object({ code: z.string().openapi({ example: "kam" }), name: z.string() }),
    ),
  })
  .openapi("UserRoleOptions");

const UserBidderCompany = z
  .object({ bidderId: z.number().int(), companyName: z.string() })
  .openapi("UserBidderCompany");

const UserClientCompany = z
  .object({ clientId: z.number().int(), companyName: z.string() })
  .openapi("UserClientCompany");

const userListFields = {
  userId: z.number().int(),
  name: z.string(),
  userLoginName: z.string(),
  emailId: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  designation: z.string().nullable(),
  role: z.string().openapi({ description: "Role code.", example: "kam" }),
  roleName: z.string(),
  isActive: z.boolean(),
  lastLoginTime: z.string().nullable(),
  createDatetime: z.string(),
  bidder: UserBidderCompany.nullable().openapi({ description: "Linked bidder company (bidder-portal users)." }),
  clients: z.array(UserClientCompany).openapi({ description: "Active client memberships." }),
};

export const UserListItem = z.object(userListFields).openapi("UserListItem");

export const UserListCounts = z
  .object({ total: z.number().int(), active: z.number().int(), inactive: z.number().int() })
  .openapi("UserListCounts");

export const UserList = paginated(UserListItem, { counts: UserListCounts }).openapi("UserList");

export const UserDetail = z
  .object({
    ...userListFields,
    whatsappNumber: z.string().nullable(),
    secondryPhoneNumber: z.string().nullable().openapi({ description: "Legacy secondary phone (spelling kept from the API)." }),
    passwordChanged: z.boolean().openapi({ description: "False while the user is on a temporary password." }),
  })
  .openapi("UserDetail");

export const UserCreated = z.object({ userId: z.number().int() }).openapi("UserCreated");

/** `{ error, code }` sent when emailing a temporary password fails. */
export const UserCredentialsErrorBody = z
  .object({
    error: z.string(),
    code: z.enum(["OTP_MISSING_EMAIL", "OTP_DELIVERY_FAILED"]),
  })
  .openapi("UserCredentialsErrorBody");

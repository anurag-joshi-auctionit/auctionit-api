import { eq, sql } from "drizzle-orm";
import { BiddersErrorMessages } from "@auctionit/messages/bidders";
import { db } from "../db/index.js";
import { bidders } from "../db/schema/bidders.js";
import type { BidderSignupInput } from "../lib/bidders/schemas.js";
import { fieldValidationErrorBody } from "../lib/validation-error.js";
import { locationsService } from "./locations.service.js";
import { bidderUsersService, isLoginAvailable } from "./users.service.js";
import { UserError } from "./users.service.js";
import { buildBidderVan } from "../lib/bidders/van.js";
import { formatUtcNow } from "@auctionit/lib/date";

// Actor recorded as created_by for self-service signups (no logged-in admin).
const SYSTEM_USER_ID = 1;

export class BidderSignupError extends Error {
  constructor(
    message: string,
    public code: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "BidderSignupError";
  }
}

export class BidderSignupService {
  /**
   * Public bidder self-registration. Creates the bidder (unverified — awaiting
   * admin approval) and a login user (active, so they can sign in immediately
   * with limited access). A temporary password is generated and emailed.
   * The bidder becomes "approved" when an admin sets is_verified.
   */
  async signup(
    input: BidderSignupInput,
  ): Promise<{ bidderId: number; userId: number }> {
    const conflicts = await collectSignupConflictFieldErrors(input);
    if (Object.keys(conflicts).length > 0) {
      throw new BidderSignupError(
        BiddersErrorMessages.FAILED_TO_REGISTER,
        "SIGNUP_CONFLICT",
        conflicts,
      );
    }

    const now = formatUtcNow();

    const bidderId = await this.insertBidder(input, now);

    let userId: number;
    try {
      const res = await bidderUsersService.createForBidder(
        bidderId,
        {
          name: input.name,
          userLoginName: input.userLoginName,
          emailId: input.emailId,
          phoneNumber: input.phoneNumber,
          whatsappNumber: input.whatsappNumber ?? null,
          designation: null,
          isActive: true,
        },
        SYSTEM_USER_ID,
        { credentialsReason: "user_created" },
      );
      userId = res.userId;
    } catch (e) {
      // Roll back the orphan bidder so a failed login creation doesn't leave
      // a half-made account.
      await db.delete(bidders).where(eq(bidders.id, bidderId));
      if (e instanceof UserError && e.code === "LOGIN_TAKEN") {
        throw new BidderSignupError(
          BiddersErrorMessages.USERNAME_TAKEN,
          "USERNAME_TAKEN",
          { userLoginName: [BiddersErrorMessages.USERNAME_TAKEN] },
        );
      }
      throw e;
    }

    return { bidderId, userId };
  }

  private async insertBidder(
    input: BidderSignupInput,
    now: string,
  ): Promise<number> {
    const loc = await locationsService.getById(input.locationId);
    if (!loc) {
      throw new BidderSignupError(
        BiddersErrorMessages.LOCATION_NOT_FOUND,
        "LOCATION_NOT_FOUND",
        { locationId: [BiddersErrorMessages.LOCATION_NOT_FOUND] },
      );
    }

    const bidderId = await nextBidderId();
    await db.insert(bidders).values({
      id: bidderId,
      companyName: input.companyName,
      address: null,
      locationId: input.locationId,
      country: loc.country ?? null,
      state: loc.state ?? null,
      city: loc.city ?? null,
      pincode: input.pincode,
      website: input.website ?? null,
      pan: input.pan,
      gstin: input.gstin,
      materials: input.materials,
      // Can sign in right away, but not yet approved (limited access).
      isActive: true,
      isVerified: false,
      van: buildBidderVan(bidderId),
      createdAt: now,
      updatedAt: now,
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
    });
    return bidderId;
  }
}

// Next integer PK for a non-identity table (values migrated from MSSQL).
async function nextBidderId(): Promise<number> {
  const res = await db.execute<{ next: number }>(
    sql`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM bidders`,
  );
  return Number(res.rows[0]?.next ?? 1);
}

export const bidderSignupService = new BidderSignupService();

function stringField(body: unknown, key: string): string {
  if (body == null || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Username conflicts for signup. Skips an empty value so the schema required
 * error stays the only message.
 */
export async function collectSignupConflictFieldErrors(
  body: unknown,
): Promise<Record<string, string[]>> {
  const userLoginName = stringField(body, "userLoginName");
  if (!userLoginName || (await isLoginAvailable(userLoginName))) return {};
  return { userLoginName: [BiddersErrorMessages.USERNAME_TAKEN] };
}

/** Shape signup conflict errors as field-level validation responses. */
export function bidderSignupErrorBody(err: BidderSignupError) {
  if (err.fieldErrors) {
    return fieldValidationErrorBody(err.fieldErrors, err.message);
  }
  return { error: err.message, code: err.code };
}

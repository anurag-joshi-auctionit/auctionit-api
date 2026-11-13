import { SubscriptionsErrorMessages } from "@auctionit/messages/subscriptions";
import { and, asc, eq, max, ne } from "drizzle-orm";
import type {
  CreateSubscriptionTypeInput,
  PatchSubscriptionTypeInput,
} from "../../lib/subscription-types/schemas.js";
import { db } from "../../db/index.js";
import { subscriptionTypes } from "../../db/schema/subscription-types.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type SubscriptionTypeDto = {
  id: number;
  name: string;
  amount: number;
  gstPercent: number;
  months: number | null;
  isActive: boolean;
};

export class SubscriptionTypeNotFoundError extends Error {
  constructor(id: number | string) {
    super(SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND_BY_ID(id));
    this.name = "SubscriptionTypeNotFoundError";
  }
}

export class SubscriptionTypeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionTypeValidationError";
  }
}

function toDto(row: typeof subscriptionTypes.$inferSelect): SubscriptionTypeDto {
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    gstPercent: Number(row.gstPercent),
    months: row.months ?? null,
    isActive: row.isActive,
  };
}

async function nextSubscriptionTypeId(): Promise<number> {
  const [row] = await db
    .select({ value: max(subscriptionTypes.id) })
    .from(subscriptionTypes);
  return (row?.value ?? 0) + 1;
}

async function assertUniqueName(
  name: string,
  excludeId?: number,
): Promise<void> {
  const conditions = excludeId
    ? and(eq(subscriptionTypes.name, name), ne(subscriptionTypes.id, excludeId))
    : eq(subscriptionTypes.name, name);

  const [existing] = await db
    .select({ id: subscriptionTypes.id })
    .from(subscriptionTypes)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new SubscriptionTypeValidationError(
      SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NAME_EXISTS,
    );
  }
}

export class SubscriptionTypesMasterService {
  async list(activeOnly: boolean): Promise<SubscriptionTypeDto[]> {
    const rows = await db
      .select()
      .from(subscriptionTypes)
      .where(activeOnly ? eq(subscriptionTypes.isActive, true) : undefined)
      .orderBy(asc(subscriptionTypes.id));
    return rows.map(toDto);
  }

  async create(
    input: CreateSubscriptionTypeInput,
    userId?: number,
  ): Promise<SubscriptionTypeDto> {
    const name = input.name.trim();
    await assertUniqueName(name);

    const id = await nextSubscriptionTypeId();
    if (id === 0) {
      throw new SubscriptionTypeValidationError(
        SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_ID_ZERO,
      );
    }

    const now = formatUtcNow();

    const [created] = await db
      .insert(subscriptionTypes)
      .values({
        id,
        name,
        amount: input.amount.toFixed(2),
        gstPercent: input.gstPercent.toFixed(2),
        months: input.months,
        isActive: input.isActive ?? true,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new SubscriptionTypeValidationError(
        SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_CREATE_FAILED,
      );
    }

    return toDto(created);
  }

  async update(
    id: number,
    input: PatchSubscriptionTypeInput,
    userId?: number,
  ): Promise<SubscriptionTypeDto> {
    const [existing] = await db
      .select()
      .from(subscriptionTypes)
      .where(eq(subscriptionTypes.id, id))
      .limit(1);

    if (!existing) {
      throw new SubscriptionTypeNotFoundError(id);
    }

    if (id === 0) {
      throw new SubscriptionTypeValidationError(
        SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_PLACEHOLDER_LOCKED,
      );
    }

    const name = input.name?.trim() ?? existing.name;
    if (input.name != null) {
      await assertUniqueName(name, id);
    }

    const [updated] = await db
      .update(subscriptionTypes)
      .set({
        name,
        amount:
          input.amount != null
            ? input.amount.toFixed(2)
            : existing.amount,
        gstPercent:
          input.gstPercent != null
            ? input.gstPercent.toFixed(2)
            : existing.gstPercent,
        months: input.months ?? existing.months,
        isActive: input.isActive ?? existing.isActive,
        updatedAt: formatUtcNow(),
        updatedBy: userId ?? null,
      })
      .where(eq(subscriptionTypes.id, id))
      .returning();

    if (!updated) {
      throw new SubscriptionTypeValidationError(
        SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_UPDATE_FAILED,
      );
    }

    return toDto(updated);
  }
}

export const subscriptionTypesMasterService =
  new SubscriptionTypesMasterService();

import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { and, asc, eq, max, ne } from "drizzle-orm";
import type {
  CreatePaymentTypeInput,
  PatchPaymentTypeInput,
} from "../../lib/payment-types/schemas.js";
import { db } from "../../db/index.js";
import { paymentTypes } from "../../db/schema/payment-types.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type PaymentTypeDto = {
  id: number;
  name: string;
  isActive: boolean;
};

export class PaymentTypeNotFoundError extends Error {
  constructor(id: number | string) {
    super(MastersErrorMessages.PAYMENT_TYPE_NOT_FOUND(id));
    this.name = "PaymentTypeNotFoundError";
  }
}

export class PaymentTypeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentTypeValidationError";
  }
}

function toDto(row: typeof paymentTypes.$inferSelect): PaymentTypeDto {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
  };
}

async function nextPaymentTypeId(): Promise<number> {
  const [row] = await db
    .select({ value: max(paymentTypes.id) })
    .from(paymentTypes);
  return (row?.value ?? 0) + 1;
}

async function assertUniqueName(
  name: string,
  excludeId?: number,
): Promise<void> {
  const conditions = excludeId
    ? and(eq(paymentTypes.name, name), ne(paymentTypes.id, excludeId))
    : eq(paymentTypes.name, name);

  const [existing] = await db
    .select({ id: paymentTypes.id })
    .from(paymentTypes)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new PaymentTypeValidationError(
      MastersValidationMessages.PAYMENT_TYPE_NAME_EXISTS,
    );
  }
}

export class PaymentTypesMasterService {
  async list(activeOnly: boolean): Promise<PaymentTypeDto[]> {
    const rows = await db
      .select()
      .from(paymentTypes)
      .where(activeOnly ? eq(paymentTypes.isActive, true) : undefined)
      .orderBy(asc(paymentTypes.id));
    return rows.map(toDto);
  }

  async getNameMap(): Promise<Record<number, string>> {
    const rows = await this.list(false);
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  async create(
    input: CreatePaymentTypeInput,
    userId?: number,
  ): Promise<PaymentTypeDto> {
    const name = input.name.trim();
    await assertUniqueName(name);

    const id = await nextPaymentTypeId();
    const now = formatUtcNow();

    const [created] = await db
      .insert(paymentTypes)
      .values({
        id,
        name,
        isActive: input.isActive ?? true,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new PaymentTypeValidationError(MastersErrorMessages.PAYMENT_TYPE_CREATE_FAILED);
    }

    return toDto(created);
  }

  async update(
    id: number,
    input: PatchPaymentTypeInput,
    userId?: number,
  ): Promise<PaymentTypeDto> {
    const [existing] = await db
      .select()
      .from(paymentTypes)
      .where(eq(paymentTypes.id, id))
      .limit(1);

    if (!existing) {
      throw new PaymentTypeNotFoundError(id);
    }

    const name = input.name?.trim() ?? existing.name;
    if (input.name != null) {
      await assertUniqueName(name, id);
    }

    const [updated] = await db
      .update(paymentTypes)
      .set({
        name,
        isActive: input.isActive ?? existing.isActive,
        updatedAt: formatUtcNow(),
        updatedBy: userId ?? null,
      })
      .where(eq(paymentTypes.id, id))
      .returning();

    if (!updated) {
      throw new PaymentTypeValidationError(MastersErrorMessages.PAYMENT_TYPE_UPDATE_FAILED);
    }

    return toDto(updated);
  }
}

export const paymentTypesMasterService = new PaymentTypesMasterService();

import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  ClientsValidationMessages,
  type AdditionalFieldDataType,
  type AdditionalFieldScope,
} from "@auctionit/messages/clients";
import { formatUtcNow } from "@auctionit/lib/date";
import { db } from "../db/index.js";
import {
  auctionAdditionalFieldValues,
  clientAdditionalFields,
} from "../db/schema/additional-fields.js";
import { clients } from "../db/schema/clients.js";
import type { AdditionalFieldInput } from "../lib/clients/schemas.js";
import { ClientNotFoundError } from "./clients.service.js";

export type ClientAdditionalField = {
  id: number;
  clientId: number;
  label: string;
  scope: AdditionalFieldScope;
  dataType: AdditionalFieldDataType;
  displayOrder: number;
  isActive: boolean;
  hasValues: boolean;
};

export class AdditionalFieldNotFoundError extends Error {
  constructor() {
    super("Additional field not found");
    this.name = "AdditionalFieldNotFoundError";
  }
}

/** Field-level validation failure; `field` is the request body key. */
export class AdditionalFieldValidationError extends Error {
  constructor(
    readonly field: keyof AdditionalFieldInput,
    message: string,
  ) {
    super(message);
    this.name = "AdditionalFieldValidationError";
  }
}

const hasValuesSql = sql<boolean>`EXISTS (
  SELECT 1 FROM ${auctionAdditionalFieldValues}
  WHERE ${auctionAdditionalFieldValues.fieldId} = ${clientAdditionalFields.id}
)`;

async function assertClientExists(clientId: number): Promise<void> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row) throw new ClientNotFoundError();
}

async function assertLabelAvailable(
  clientId: number,
  scope: AdditionalFieldScope,
  label: string,
  excludeId?: number,
): Promise<void> {
  const [dup] = await db
    .select({ id: clientAdditionalFields.id })
    .from(clientAdditionalFields)
    .where(
      and(
        eq(clientAdditionalFields.clientId, clientId),
        eq(clientAdditionalFields.scope, scope),
        sql`lower(${clientAdditionalFields.label}) = lower(${label})`,
        excludeId != null ? ne(clientAdditionalFields.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  if (dup) {
    throw new AdditionalFieldValidationError(
      "label",
      ClientsValidationMessages.ADDITIONAL_FIELD_LABEL_TAKEN,
    );
  }
}

async function list(clientId: number): Promise<ClientAdditionalField[]> {
  await assertClientExists(clientId);
  return db
    .select({
      id: clientAdditionalFields.id,
      clientId: clientAdditionalFields.clientId,
      label: clientAdditionalFields.label,
      scope: clientAdditionalFields.scope,
      dataType: clientAdditionalFields.dataType,
      displayOrder: clientAdditionalFields.displayOrder,
      isActive: clientAdditionalFields.isActive,
      hasValues: hasValuesSql,
    })
    .from(clientAdditionalFields)
    .where(eq(clientAdditionalFields.clientId, clientId))
    .orderBy(
      asc(clientAdditionalFields.scope),
      asc(clientAdditionalFields.displayOrder),
      asc(clientAdditionalFields.id),
    );
}

async function create(
  clientId: number,
  input: AdditionalFieldInput,
  userId: number,
): Promise<{ id: number }> {
  await assertClientExists(clientId);
  await assertLabelAvailable(clientId, input.scope, input.label);
  const [row] = await db
    .insert(clientAdditionalFields)
    .values({
      clientId,
      label: input.label,
      scope: input.scope,
      dataType: input.dataType,
      displayOrder: input.displayOrder,
      isActive: true,
      createdBy: userId,
    })
    .returning({ id: clientAdditionalFields.id });
  return { id: row!.id };
}

async function getOwned(clientId: number, fieldId: number) {
  const [row] = await db
    .select({
      id: clientAdditionalFields.id,
      scope: clientAdditionalFields.scope,
      dataType: clientAdditionalFields.dataType,
      hasValues: hasValuesSql,
    })
    .from(clientAdditionalFields)
    .where(
      and(
        eq(clientAdditionalFields.id, fieldId),
        eq(clientAdditionalFields.clientId, clientId),
      ),
    )
    .limit(1);
  if (!row) throw new AdditionalFieldNotFoundError();
  return row;
}

async function update(
  clientId: number,
  fieldId: number,
  input: AdditionalFieldInput,
  userId: number,
): Promise<void> {
  const existing = await getOwned(clientId, fieldId);
  if (existing.hasValues && existing.scope !== input.scope) {
    throw new AdditionalFieldValidationError(
      "scope",
      ClientsValidationMessages.ADDITIONAL_FIELD_SCOPE_LOCKED,
    );
  }
  if (existing.hasValues && existing.dataType !== input.dataType) {
    throw new AdditionalFieldValidationError(
      "dataType",
      ClientsValidationMessages.ADDITIONAL_FIELD_TYPE_LOCKED,
    );
  }
  await assertLabelAvailable(clientId, input.scope, input.label, fieldId);
  await db
    .update(clientAdditionalFields)
    .set({
      label: input.label,
      scope: input.scope,
      dataType: input.dataType,
      displayOrder: input.displayOrder,
      updatedAt: formatUtcNow(),
      updatedBy: userId,
    })
    .where(eq(clientAdditionalFields.id, fieldId));
}

async function setActive(
  clientId: number,
  fieldId: number,
  isActive: boolean,
  userId: number,
): Promise<void> {
  await getOwned(clientId, fieldId);
  await db
    .update(clientAdditionalFields)
    .set({ isActive, updatedAt: formatUtcNow(), updatedBy: userId })
    .where(eq(clientAdditionalFields.id, fieldId));
}

export const clientAdditionalFieldsService = {
  list,
  create,
  update,
  setActive,
};

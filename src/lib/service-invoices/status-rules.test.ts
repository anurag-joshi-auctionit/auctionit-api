import { describe, expect, it } from "vitest";
import {
  ACCOUNTS_FIELD_EDITABLE_STATUSES,
  ACCOUNTS_PDF_UPLOAD_STATUSES,
  canAccountsTransition,
  isAdminEditableStatus,
  isCancelledStatus,
} from "./status-rules.js";
import { statusStampFields } from "./status-stamps.js";

describe("ACCOUNTS_PDF_UPLOAD_STATUSES", () => {
  it("allows requested and generated only", () => {
    expect(ACCOUNTS_PDF_UPLOAD_STATUSES.has("requested")).toBe(true);
    expect(ACCOUNTS_PDF_UPLOAD_STATUSES.has("generated")).toBe(true);
    expect(ACCOUNTS_PDF_UPLOAD_STATUSES.has("draft")).toBe(false);
    expect(ACCOUNTS_PDF_UPLOAD_STATUSES.has("recheck")).toBe(false);
    expect(ACCOUNTS_PDF_UPLOAD_STATUSES.has("cancelled")).toBe(false);
  });

  it("keeps invoice field edits narrower than PDF upload", () => {
    expect(ACCOUNTS_FIELD_EDITABLE_STATUSES.has("requested")).toBe(true);
    expect(ACCOUNTS_FIELD_EDITABLE_STATUSES.has("generated")).toBe(false);
  });
});

describe("isAdminEditableStatus", () => {
  it("allows only draft and recheck", () => {
    expect(isAdminEditableStatus("draft")).toBe(true);
    expect(isAdminEditableStatus("recheck")).toBe(true);
    expect(isAdminEditableStatus("requested")).toBe(false);
    expect(isAdminEditableStatus("generated")).toBe(false);
    expect(isAdminEditableStatus("cancelled")).toBe(false);
  });
});

describe("isCancelledStatus", () => {
  it("is true only for cancelled", () => {
    expect(isCancelledStatus("cancelled")).toBe(true);
    expect(isCancelledStatus("generated")).toBe(false);
    expect(isCancelledStatus("requested")).toBe(false);
  });
});

describe("canAccountsTransition", () => {
  it("allows requested → recheck | generated", () => {
    expect(canAccountsTransition("requested", "recheck")).toBe(true);
    expect(canAccountsTransition("requested", "generated")).toBe(true);
    expect(canAccountsTransition("requested", "cancelled")).toBe(false);
  });

  it("blocks accounts actions while in recheck (admin must re-request)", () => {
    expect(canAccountsTransition("recheck", "generated")).toBe(false);
    expect(canAccountsTransition("recheck", "requested")).toBe(false);
    expect(canAccountsTransition("recheck", "cancelled")).toBe(false);
  });

  it("allows generated → cancelled only", () => {
    expect(canAccountsTransition("generated", "cancelled")).toBe(true);
    expect(canAccountsTransition("generated", "recheck")).toBe(false);
    expect(canAccountsTransition("generated", "generated")).toBe(false);
  });

  it("blocks transitions from cancelled and draft", () => {
    expect(canAccountsTransition("cancelled", "generated")).toBe(false);
    expect(canAccountsTransition("draft", "requested")).toBe(false);
  });
});

describe("statusStampFields", () => {
  const now = "2026-07-23T10:00:00.000Z";
  const userId = 42;

  it("stamps requested/recheck/generated/cancelled", () => {
    expect(statusStampFields("requested", now, userId)).toEqual({
      requestedAt: now,
      requestedBy: userId,
    });
    expect(statusStampFields("recheck", now, userId)).toEqual({
      recheckedAt: now,
      recheckedBy: userId,
    });
    expect(statusStampFields("generated", now, userId)).toEqual({
      generatedAt: now,
      generatedBy: userId,
    });
    expect(statusStampFields("cancelled", now, userId)).toEqual({
      cancelledAt: now,
      cancelledBy: userId,
    });
  });
});

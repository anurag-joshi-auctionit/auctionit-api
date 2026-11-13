import { describe, expect, it } from "vitest";
import {
  canAccountsInvoiceTransition,
  canAdminInvoiceTransition,
  isAccountsUploadAllowed,
  isAdminEditableStatus,
  isCancelledInvoiceStatus,
} from "./invoice-status-rules.js";

describe("subscription invoice status rules", () => {
  it("allows accounts requested → recheck/cancelled and generated → cancelled", () => {
    expect(canAccountsInvoiceTransition("requested", "recheck")).toBe(true);
    expect(canAccountsInvoiceTransition("requested", "cancelled")).toBe(true);
    expect(canAccountsInvoiceTransition("recheck", "cancelled")).toBe(true);
    expect(canAccountsInvoiceTransition("generated", "cancelled")).toBe(true);
    expect(canAccountsInvoiceTransition("recheck", "requested")).toBe(false);
    expect(canAccountsInvoiceTransition("generated", "recheck")).toBe(false);
  });

  it("allows admin recheck → requested only", () => {
    expect(canAdminInvoiceTransition("recheck", "requested")).toBe(true);
    expect(canAdminInvoiceTransition("requested", "recheck")).toBe(false);
    expect(canAdminInvoiceTransition("generated", "cancelled")).toBe(false);
  });

  it("allows upload for requested and generated", () => {
    expect(isAccountsUploadAllowed("requested")).toBe(true);
    expect(isAccountsUploadAllowed("generated")).toBe(true);
    expect(isAccountsUploadAllowed("recheck")).toBe(false);
    expect(isAccountsUploadAllowed("cancelled")).toBe(false);
  });

  it("allows admin edit only for recheck", () => {
    expect(isAdminEditableStatus("recheck")).toBe(true);
    expect(isAdminEditableStatus("requested")).toBe(false);
    expect(isAdminEditableStatus("generated")).toBe(false);
    expect(isAdminEditableStatus("cancelled")).toBe(false);
  });

  it("detects cancelled", () => {
    expect(isCancelledInvoiceStatus("cancelled")).toBe(true);
    expect(isCancelledInvoiceStatus("generated")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildSubscriptionInvoicePdfFilename,
  buildSubscriptionInvoicePdfS3Key,
} from "./invoice-r2-keys.js";

describe("subscription invoice R2 keys", () => {
  it("builds stable key and filename", () => {
    expect(
      buildSubscriptionInvoicePdfS3Key({ subscriptionId: 12, bidderId: 45 }),
    ).toBe("subscriptions/subscription-12-45.pdf");
    expect(
      buildSubscriptionInvoicePdfFilename({
        subscriptionId: 12,
        bidderId: 45,
      }),
    ).toBe("subscription-12-45.pdf");
  });
});

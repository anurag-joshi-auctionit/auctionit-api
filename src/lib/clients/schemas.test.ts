import { ClientsValidationMessages } from "@auctionit/messages/clients";
import {
  hasValidServiceFeeDecimals,
  isValidServiceFeeInput,
  isValidServiceFeeNumber,
} from "@auctionit/messages/clients";
import { describe, expect, it } from "vitest";
import {
  auctionSettingsSchema,
  companyInfoSchema,
  companyInfoUpdateSchema,
  createClientSchema,
  materialLocationBodySchema,
  nullableGstinSchema,
  nullablePanSchema,
  nullableTanSchema,
  pincodeSchema,
  plantLocationBodySchema,
} from "./schemas.js";

const validCompanyInfo = {
  address: "123 Industrial Area",
  locationId: 1,
  pincode: "560001",
  phone: "9876543210",
  email: "contact@company.com",
  pan: "ABCDE1234F",
  gstin: "07ABCDE1234F1Z5",
  materials: [1],
};

const validPlantLocation = {
  name: "Plant 1",
  locationId: 1,
  kamId: 1,
  pincode: "560001",
  gstin: "07ABCDE1234F1Z5",
  pan: "ABCDE1234F",
  pocName: "John Doe",
  pocEmail: "john@example.com",
  pocPhone: "9876543210",
  billingName: "Billing Contact",
  billingEmailTo: "billing@example.com",
};

describe("nullable field schemas", () => {
  it("accepts valid pincode", () => {
    expect(pincodeSchema.parse("560001")).toBe("560001");
    expect(pincodeSchema.parse("")).toBeNull();
  });

  it("normalizes spaced/letter-mixed pincode before validating", () => {
    expect(pincodeSchema.parse("560 001")).toBe("560001");
  });

  it("rejects invalid pincode with message", () => {
    const result = pincodeSchema.safeParse("56001");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        ClientsValidationMessages.INVALID_PINCODE,
      );
    }
  });

  it("accepts valid PAN", () => {
    expect(nullablePanSchema.parse("ABCDE1234F")).toBe("ABCDE1234F");
  });

  it("normalizes lowercase PAN before validating", () => {
    expect(nullablePanSchema.parse("abcde1234f")).toBe("ABCDE1234F");
  });

  it("rejects invalid PAN with message", () => {
    const result = nullablePanSchema.safeParse("INVALID");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        ClientsValidationMessages.INVALID_PAN,
      );
    }
  });

  it("accepts valid TAN", () => {
    expect(nullableTanSchema.parse("ABCD12345E")).toBe("ABCD12345E");
  });

  it("normalizes lowercase TAN before validating", () => {
    expect(nullableTanSchema.parse("abcd12345e")).toBe("ABCD12345E");
  });

  it("accepts valid GSTIN", () => {
    expect(nullableGstinSchema.parse("22ABCDE1234F1Z5")).toBe(
      "22ABCDE1234F1Z5",
    );
  });

  it("normalizes lowercase GSTIN before validating", () => {
    expect(nullableGstinSchema.parse("22abcde1234f1z5")).toBe(
      "22ABCDE1234F1Z5",
    );
  });
});

describe("companyInfoSchema phone/pincode hardening", () => {
  it("normalizes dashed phone and accepts", () => {
    const parsed = companyInfoSchema.parse({
      ...validCompanyInfo,
      phone: "98765-43210",
    });
    expect(parsed.phone).toBe("9876543210");
  });

  it("rejects phone that is not 10 digits after normalize", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      phone: "+917503465404",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("service fee validation", () => {
  it("accepts values within range with up to 3 decimal places", () => {
    expect(isValidServiceFeeNumber(0)).toBe(true);
    expect(isValidServiceFeeNumber(0.001)).toBe(true);
    expect(isValidServiceFeeNumber(0.5)).toBe(true);
    expect(isValidServiceFeeNumber(5)).toBe(true);
    expect(isValidServiceFeeInput("1.234")).toBe(true);
  });

  it("rejects out-of-range and over-precision values", () => {
    expect(isValidServiceFeeNumber(-0.001)).toBe(false);
    expect(isValidServiceFeeNumber(0.0009)).toBe(false);
    expect(isValidServiceFeeNumber(5.001)).toBe(false);
    expect(hasValidServiceFeeDecimals(0.1234)).toBe(false);
    expect(isValidServiceFeeInput("5.0001")).toBe(false);
    expect(isValidServiceFeeInput("abc")).toBe(false);
  });
});

describe("auctionSettingsSchema", () => {
  const base = {
    auctionPrefix: "TEST/",
    serviceFeeType: "service_percentage" as const,
    serviceFeeValue: 0.5,
    isLastBidExtension: false,
    lastBidExtensionWindow: 0,
    lastBidExtensionInterval: 0,
    lastBidExtensionCountMax: 0,
    isStaggered: false,
    staggerInterval: 0,
  };

  it("requires auction prefix", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      auctionPrefix: "",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "auctionPrefix",
      );
      expect(issue?.message).toBe(
        ClientsValidationMessages.AUCTION_PREFIX_REQUIRED,
      );
    }
  });

  it("accepts all last-bid fields as 0 (off)", () => {
    expect(auctionSettingsSchema.safeParse(base).success).toBe(true);
  });

  it("accepts all last-bid fields as positive (on)", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      isLastBidExtension: true,
      lastBidExtensionWindow: 120,
      lastBidExtensionInterval: 60,
      lastBidExtensionCountMax: 5,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects mixed zero/non-zero last-bid fields", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      lastBidExtensionWindow: 120,
      lastBidExtensionInterval: 0,
      lastBidExtensionCountMax: 5,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        ClientsValidationMessages.LAST_BID_EXTENSION_TRIPLE,
      );
    }
  });

  it("rejects last bid window above 120", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      isLastBidExtension: true,
      lastBidExtensionWindow: 2000000,
      lastBidExtensionInterval: 60,
      lastBidExtensionCountMax: 5,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (i) =>
            i.path[0] === "lastBidExtensionWindow" &&
            i.message === ClientsValidationMessages.EXTEND_WINDOW_RANGE,
        ),
      ).toBe(true);
    }
  });

  it("rejects negative extension interval", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      lastBidExtensionWindow: 120,
      lastBidExtensionInterval: -1,
      lastBidExtensionCountMax: 5,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (i) =>
            i.path[0] === "lastBidExtensionInterval" &&
            i.message === ClientsValidationMessages.EXTEND_INTERVAL_RANGE,
        ),
      ).toBe(true);
    }
  });

  it("accepts zero service fee percentage", () => {
    expect(
      auctionSettingsSchema.safeParse({ ...base, serviceFeeValue: 0 }).success,
    ).toBe(true);
  });

  it("rejects negative service fee with message", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      serviceFeeValue: -0.001,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "serviceFeeValue",
      );
      expect(issue?.message).toBe(
        ClientsValidationMessages.SERVICE_FEE_PERCENTAGE_INVALID,
      );
    }
  });

  it("rejects service fee above max with message", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      serviceFeeValue: 5.001,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "serviceFeeValue",
      );
      expect(issue?.message).toBe(
        ClientsValidationMessages.SERVICE_FEE_PERCENTAGE_INVALID,
      );
    }
  });

  it("rejects service fee with more than 3 decimal places", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      serviceFeeValue: 0.1234,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "serviceFeeValue",
      );
      expect(issue?.message).toBe(
        ClientsValidationMessages.SERVICE_FEE_PERCENTAGE_INVALID,
      );
    }
  });

  it("accepts service fee at min and max bounds", () => {
    expect(
      auctionSettingsSchema.safeParse({ ...base, serviceFeeValue: 0 }).success,
    ).toBe(true);
    expect(
      auctionSettingsSchema.safeParse({ ...base, serviceFeeValue: 5 }).success,
    ).toBe(true);
  });

  it("accepts fixed_amount and pmt values >= 0 outside percentage range", () => {
    expect(
      auctionSettingsSchema.safeParse({
        ...base,
        serviceFeeType: "fixed_amount",
        serviceFeeValue: 100,
      }).success,
    ).toBe(true);
    expect(
      auctionSettingsSchema.safeParse({
        ...base,
        serviceFeeType: "fixed_amount",
        serviceFeeValue: 0,
      }).success,
    ).toBe(true);
    expect(
      auctionSettingsSchema.safeParse({
        ...base,
        serviceFeeType: "pmt",
        serviceFeeValue: 10,
      }).success,
    ).toBe(true);
    expect(
      auctionSettingsSchema.safeParse({
        ...base,
        serviceFeeType: "pmt",
        serviceFeeValue: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects fixed_amount and pmt values that are negative", () => {
    const fixed = auctionSettingsSchema.safeParse({
      ...base,
      serviceFeeType: "fixed_amount",
      serviceFeeValue: -1,
    });
    expect(fixed.success).toBe(false);
    if (!fixed.success) {
      const issue = fixed.error.issues.find(
        (i) => i.path[0] === "serviceFeeValue",
      );
      expect(issue?.message).toBe(
        ClientsValidationMessages.SERVICE_FEE_VALUE_POSITIVE,
      );
    }
  });

  it("accepts stagger off with interval 0, and on with a positive interval", () => {
    expect(
      auctionSettingsSchema.safeParse({
        ...base,
        isStaggered: false,
        staggerInterval: 0,
      }).success,
    ).toBe(true);
    expect(
      auctionSettingsSchema.safeParse({
        ...base,
        isStaggered: true,
        staggerInterval: 120,
      }).success,
    ).toBe(true);
  });

  // Regression: the flag used to be derived as `interval > 0`, so turning
  // staggering off while keeping the interval was impossible.
  it("accepts stagger off while keeping a positive interval", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      isStaggered: false,
      staggerInterval: 120,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.isStaggered).toBe(false);
      expect(parsed.data.staggerInterval).toBe(120);
    }
  });

  it("rejects stagger on with a zero interval", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      isStaggered: true,
      staggerInterval: 0,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (i) =>
            i.path[0] === "staggerInterval" &&
            i.message === ClientsValidationMessages.STAGGER_INTERVAL_REQUIRED,
        ),
      ).toBe(true);
    }
  });

  it("rejects negative stagger interval", () => {
    const parsed = auctionSettingsSchema.safeParse({
      ...base,
      staggerInterval: -1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (i) =>
            i.path[0] === "staggerInterval" &&
            i.message === ClientsValidationMessages.STAGGER_INTERVAL_RANGE,
        ),
      ).toBe(true);
    }
  });
});

describe("companyInfoSchema", () => {
  it("accepts optional isActive with required fields", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      isActive: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.isActive).toBe(false);
    }
  });

  it("rejects a blank address", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      address: "   ",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "address");
      expect(issue?.message).toBe(ClientsValidationMessages.ADDRESS_REQUIRED);
    }
  });

  it("requires address, pincode, phone, email, pan, gstin, and materials", () => {
    const parsed = companyInfoSchema.safeParse({
      locationId: 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("address");
      expect(paths).toContain("pincode");
      expect(paths).toContain("phone");
      expect(paths).toContain("email");
      expect(paths).toContain("pan");
      expect(paths).toContain("gstin");
      expect(paths).toContain("materials");
    }
  });

  it("requires at least one material", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      materials: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "materials");
      expect(issue?.message).toBe(ClientsValidationMessages.MATERIALS_REQUIRED);
    }
  });

  it("rejects phone that is not exactly 10 digits", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      phone: "12345",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "phone");
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_PHONE);
    }
  });

  it("accepts empty website as null", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      website: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.website).toBeNull();
    }
  });

  it("accepts website with a TLD", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      website: "https://adani.com",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.website).toBe("https://adani.com");
    }
  });

  it("rejects website without a TLD", () => {
    for (const website of [
      "adani",
      "adani.",
      "https://adani",
      "https://adani.",
    ]) {
      const parsed = companyInfoSchema.safeParse({
        ...validCompanyInfo,
        website,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issue = parsed.error.issues.find((i) => i.path[0] === "website");
        expect(issue?.message).toBe(ClientsValidationMessages.INVALID_WEBSITE);
      }
    }
  });

  it("rejects email-like website values", () => {
    const parsed = companyInfoSchema.safeParse({
      ...validCompanyInfo,
      website: "https://cpmpany@hdscs.cpm",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "website");
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_WEBSITE);
    }
  });
});

describe("companyInfoUpdateSchema", () => {
  it("requires service fee type and value", () => {
    const parsed = companyInfoUpdateSchema.safeParse(validCompanyInfo);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("serviceFeeType");
      expect(paths).toContain("serviceFeeValue");
    }
  });

  it("accepts company info with service fee fields", () => {
    const parsed = companyInfoUpdateSchema.safeParse({
      ...validCompanyInfo,
      serviceFeeType: "service_percentage",
      serviceFeeValue: 0.5,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("createClientSchema", () => {
  const validCreateBase = {
    companyName: "Acme",
    companyInfo: validCompanyInfo,
    serviceFeeType: "service_percentage" as const,
    serviceFeeValue: 0.5,
    plantLocations: [validPlantLocation],
  };

  it("lowercases company email", () => {
    const parsed = createClientSchema.parse({
      ...validCreateBase,
      companyInfo: {
        ...validCompanyInfo,
        email: "Contact@Company.COM",
      },
    });
    expect(parsed.companyInfo?.email).toBe("contact@company.com");
  });

  it("requires company location when companyInfo is provided", () => {
    const parsed = createClientSchema.safeParse({
      ...validCreateBase,
      companyInfo: {
        ...validCompanyInfo,
        locationId: null,
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path.join(".") === "companyInfo.locationId",
      );
      expect(issue?.message).toBe(ClientsValidationMessages.LOCATION_REQUIRED);
    }
  });

  it("rejects invalid company PAN with message", () => {
    const parsed = createClientSchema.safeParse({
      ...validCreateBase,
      companyInfo: {
        ...validCompanyInfo,
        pan: "INVALID",
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const panIssue = parsed.error.issues.find(
        (i) => i.path.join(".") === "companyInfo.pan",
      );
      expect(panIssue?.message).toBe(ClientsValidationMessages.INVALID_PAN);
    }
  });

  it("requires at least one plant location", () => {
    const parsed = createClientSchema.safeParse({
      ...validCreateBase,
      plantLocations: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "plantLocations",
      );
      expect(issue?.message).toBe(
        ClientsValidationMessages.PLANT_LOCATION_REQUIRED,
      );
    }
  });

  it("requires service fee type and value", () => {
    const parsed = createClientSchema.safeParse({
      companyName: "Acme",
      companyInfo: validCompanyInfo,
      plantLocations: [validPlantLocation],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("serviceFeeType");
      expect(paths).toContain("serviceFeeValue");
    }
  });
});

describe("materialLocationBodySchema", () => {
  it("requires pincode when adding a material location", () => {
    const parsed = materialLocationBodySchema.safeParse({
      name: "Warehouse A",
      locationId: 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "pincode");
      expect(issue?.message).toBe(ClientsValidationMessages.PINCODE_REQUIRED);
    }
  });
});

describe("plantLocationBodySchema", () => {
  it("requires pincode, gstin, pan, poc, and billing fields", () => {
    const parsed = plantLocationBodySchema.safeParse({
      name: "Plant 1",
      locationId: 1,
      kamId: 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("pincode");
      expect(paths).toContain("gstin");
      expect(paths).toContain("pan");
      expect(paths).toContain("pocName");
      expect(paths).toContain("pocEmail");
      expect(paths).toContain("pocPhone");
      expect(paths).toContain("billingName");
      expect(paths).toContain("billingEmailTo");
      expect(paths).not.toContain("serviceFee");
    }
  });

  it("accepts optional order number and order date", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      orderNumber: "PO-1001",
      orderDate: "2024-06-15T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.orderNumber).toBe("PO-1001");
      expect(parsed.data.orderDate).toBe("2024-06-15T00:00:00.000Z");
    }
  });

  it("accepts empty order number and order date as null", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      orderNumber: "",
      orderDate: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.orderNumber).toBeNull();
      expect(parsed.data.orderDate).toBeNull();
    }
  });

  it("accepts valid plant location with optional address and billing Cc", () => {
    const parsed = plantLocationBodySchema.safeParse(validPlantLocation);
    expect(parsed.success).toBe(true);
  });

  it("rejects empty billing name and billing email To", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      billingName: "",
      billingEmailTo: "",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const byPath = Object.fromEntries(
        parsed.error.issues.map((i) => [i.path[0], i.message]),
      );
      expect(byPath.billingName).toBe(
        ClientsValidationMessages.BILLING_NAME_REQUIRED,
      );
      expect(byPath.billingEmailTo).toBe(
        ClientsValidationMessages.BILLING_EMAIL_TO_REQUIRED,
      );
    }
  });

  it("accepts multiple comma-separated poc emails and phones", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      pocEmail: "john@example.com, jane@example.com",
      pocPhone: "9876543210, 9123456789",
    });
    expect(parsed.success).toBe(true);
  });

  it("lowercases comma-separated emails on save", () => {
    const parsed = plantLocationBodySchema.parse({
      ...validPlantLocation,
      pocEmail: "John@Example.COM, Jane@Example.COM",
      billingEmailTo: "Billing@Example.COM",
      billingEmailCc: "Cc@Example.COM, Other@Example.COM",
    });
    expect(parsed.pocEmail).toBe("john@example.com, jane@example.com");
    expect(parsed.billingEmailTo).toBe("billing@example.com");
    expect(parsed.billingEmailCc).toBe("cc@example.com, other@example.com");
  });

  it("rejects invalid poc email in comma-separated list", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      pocEmail: "john@example.com, not-an-email",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "pocEmail");
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_EMAIL);
    }
  });

  it("rejects consecutive dots and missing @ in poc emails", () => {
    for (const pocEmail of ["abc@gmail..com", "abcgmail.com"]) {
      const parsed = plantLocationBodySchema.safeParse({
        ...validPlantLocation,
        pocEmail,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issue = parsed.error.issues.find((i) => i.path[0] === "pocEmail");
        expect(issue?.message).toBe(ClientsValidationMessages.INVALID_EMAIL);
      }
    }
  });

  it("rejects invalid poc phone in comma-separated list", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      pocPhone: "9876543210, abc",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "pocPhone");
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_PHONE);
    }
  });

  it("rejects poc phone that is not exactly 10 digits", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      pocPhone: "12345678901",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "pocPhone");
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_PHONE);
    }
  });

  it("rejects invalid billing emails when provided", () => {
    const parsed = plantLocationBodySchema.safeParse({
      ...validPlantLocation,
      billingEmailTo: "billing@example.com, bad",
      billingEmailCc: "cc@example.com",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "billingEmailTo",
      );
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_EMAIL);
    }
  });

  it("rejects invalid poc email/phone on partial (PATCH) schema", () => {
    const partial = plantLocationBodySchema.partial();
    const emailParsed = partial.safeParse({
      pocEmail: "not-an-email",
    });
    expect(emailParsed.success).toBe(false);
    if (!emailParsed.success) {
      const issue = emailParsed.error.issues.find(
        (i) => i.path[0] === "pocEmail",
      );
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_EMAIL);
    }

    const phoneParsed = partial.safeParse({
      pocPhone: "12345",
    });
    expect(phoneParsed.success).toBe(false);
    if (!phoneParsed.success) {
      const issue = phoneParsed.error.issues.find(
        (i) => i.path[0] === "pocPhone",
      );
      expect(issue?.message).toBe(ClientsValidationMessages.INVALID_PHONE);
    }
  });
});

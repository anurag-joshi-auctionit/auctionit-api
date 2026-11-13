import { BiddersValidationMessages } from "@auctionit/messages/bidders";
import { describe, expect, it } from "vitest";
import {
  bidderInfoSchema,
  bidderSignupSchema,
  createBidderSchema,
} from "./schemas.js";

const validUser = {
  name: "John Doe",
  userLoginName: "johndoe",
  emailId: "john@example.com",
  phoneNumber: "9876543210",
};

const validBidder = {
  companyName: "Acme Bidder",
  locationId: 1,
  pincode: "560001",
  pan: "ABCDE1234F",
  gstin: "07ABCDE1234F1Z5",
  materials: [1],
  user: validUser,
};

const validSignup = {
  companyName: "Acme Bidder",
  locationId: 1,
  pincode: "560001",
  pan: "ABCDE1234F",
  gstin: "07ABCDE1234F1Z5",
  materials: [1],
  name: "John Doe",
  userLoginName: "acmebidder",
  emailId: "john@example.com",
  phoneNumber: "9876543210",
};

const validInfo = {
  companyName: "Acme Bidder",
  locationId: 1,
  pincode: "560001",
  pan: "ABCDE1234F",
  gstin: "07ABCDE1234F1Z5",
  materials: [1],
};

describe("createBidderSchema", () => {
  it("accepts a valid bidder payload with nested user", () => {
    const parsed = createBidderSchema.safeParse(validBidder);
    expect(parsed.success).toBe(true);
  });

  it("lowercases nested user email", () => {
    const parsed = createBidderSchema.parse({
      ...validBidder,
      user: { ...validUser, emailId: "John@Example.COM" },
    });
    expect(parsed.user.emailId).toBe("john@example.com");
  });

  it("requires company fields and nested user", () => {
    const parsed = createBidderSchema.safeParse({
      companyName: "Acme Bidder",
      locationId: 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("pincode");
      expect(paths).toContain("pan");
      expect(paths).toContain("gstin");
      expect(paths).toContain("materials");
      expect(paths).toContain("user");
    }
  });

  it("rejects invalid PAN with message", () => {
    const parsed = createBidderSchema.safeParse({
      ...validBidder,
      pan: "INVALID",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "pan");
      expect(issue?.message).toBe(BiddersValidationMessages.INVALID_PAN);
    }
  });

  it("requires at least one material", () => {
    const parsed = createBidderSchema.safeParse({
      ...validBidder,
      materials: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "materials");
      expect(issue?.message).toBe(
        BiddersValidationMessages.MATERIALS_REQUIRED,
      );
    }
  });

  it("rejects invalid user phone with message", () => {
    const parsed = createBidderSchema.safeParse({
      ...validBidder,
      user: { ...validUser, phoneNumber: "12345" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "user" && i.path[1] === "phoneNumber",
      );
      expect(issue?.message).toBe(BiddersValidationMessages.INVALID_PHONE);
    }
  });

  it("normalizes lowercase PAN and dashed phone on accept", () => {
    const parsed = createBidderSchema.parse({
      ...validBidder,
      pan: "abcde1234f",
      gstin: "07abcde1234f1z5",
      user: { ...validUser, phoneNumber: "98765-43210" },
    });
    expect(parsed.pan).toBe("ABCDE1234F");
    expect(parsed.user.phoneNumber).toBe("9876543210");
    expect(parsed.gstin).toBe("07ABCDE1234F1Z5");
  });

  it("accepts website with a TLD and empty as null", () => {
    const withSite = createBidderSchema.safeParse({
      ...validBidder,
      website: "https://adani.com",
    });
    expect(withSite.success).toBe(true);
    if (withSite.success) {
      expect(withSite.data.website).toBe("https://adani.com");
    }

    const empty = createBidderSchema.safeParse({
      ...validBidder,
      website: "",
    });
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data.website).toBeNull();
    }
  });

  it("rejects website without a TLD", () => {
    for (const website of ["adani", "adani.", "https://adani"]) {
      const parsed = createBidderSchema.safeParse({
        ...validBidder,
        website,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issue = parsed.error.issues.find((i) => i.path[0] === "website");
        expect(issue?.message).toBe(BiddersValidationMessages.INVALID_WEBSITE);
      }
    }
  });
});

describe("bidderInfoSchema", () => {
  it("accepts a valid company profile update without user", () => {
    const parsed = bidderInfoSchema.safeParse(validInfo);
    expect(parsed.success).toBe(true);
  });

  it("requires company name on update", () => {
    const parsed = bidderInfoSchema.safeParse({
      ...validInfo,
      companyName: "",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === "companyName");
      expect(issue?.message).toBe(
        BiddersValidationMessages.COMPANY_NAME_REQUIRED,
      );
    }
  });
});

describe("bidderSignupSchema", () => {
  it("accepts a valid signup payload", () => {
    const parsed = bidderSignupSchema.safeParse(validSignup);
    expect(parsed.success).toBe(true);
  });

  it("requires profile fields plus contact and username", () => {
    const parsed = bidderSignupSchema.safeParse({
      companyName: "Acme Bidder",
      locationId: 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("pincode");
      expect(paths).toContain("pan");
      expect(paths).toContain("gstin");
      expect(paths).toContain("materials");
      expect(paths).toContain("name");
      expect(paths).toContain("emailId");
      expect(paths).toContain("phoneNumber");
      expect(paths).toContain("userLoginName");
    }
  });

  it("rejects empty username", () => {
    const parsed = bidderSignupSchema.safeParse({
      ...validSignup,
      userLoginName: "   ",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(
        (i) => i.path[0] === "userLoginName",
      );
      expect(issue?.message).toBe(BiddersValidationMessages.USERNAME_REQUIRED);
    }
  });

  it("rejects invalid GSTIN / PAN / phone", () => {
    const parsed = bidderSignupSchema.safeParse({
      ...validSignup,
      gstin: "BAD",
      pan: "INVALID",
      phoneNumber: "12345",
      materials: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const byPath = Object.fromEntries(
        parsed.error.issues.map((i) => [String(i.path[0]), i.message]),
      );
      expect(byPath.gstin).toBe(BiddersValidationMessages.INVALID_GSTIN);
      expect(byPath.pan).toBe(BiddersValidationMessages.INVALID_PAN);
      expect(byPath.phoneNumber).toBe(BiddersValidationMessages.INVALID_PHONE);
      expect(byPath.materials).toBe(
        BiddersValidationMessages.MATERIALS_REQUIRED,
      );
    }
  });

  it("normalizes tax and phone fields on accept", () => {
    const parsed = bidderSignupSchema.parse({
      ...validSignup,
      pan: "abcde1234f",
      phoneNumber: "98765-43210",
      gstin: "07abcde1234f1z5",
    });
    expect(parsed.pan).toBe("ABCDE1234F");
    expect(parsed.phoneNumber).toBe("9876543210");
    expect(parsed.gstin).toBe("07ABCDE1234F1Z5");
  });
});

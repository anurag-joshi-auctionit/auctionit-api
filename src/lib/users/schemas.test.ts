import { UsersValidationMessages } from "@auctionit/messages/users";
import { describe, expect, it } from "vitest";
import {
  createEntityUserSchema,
  createStaffUserSchema,
  updateEntityUserSchema,
  updateStaffUserSchema,
} from "./schemas.js";

const validEntityCreate = {
  name: "Jane Doe",
  userLoginName: "jane",
  emailId: "jane@example.com",
  phoneNumber: "9876543210",
  whatsappNumber: "",
  designation: "",
  isActive: true,
};

describe("entity user schemas", () => {
  it("accepts valid create payload and normalizes phone", () => {
    const parsed = createEntityUserSchema.parse(validEntityCreate);
    expect(parsed.phoneNumber).toBe("9876543210");
    expect(parsed.whatsappNumber).toBeNull();
    expect(parsed.emailId).toBe("jane@example.com");
  });

  it("lowercases email on create", () => {
    const parsed = createEntityUserSchema.parse({
      ...validEntityCreate,
      emailId: "Jane@Example.COM",
    });
    expect(parsed.emailId).toBe("jane@example.com");
  });

  it("rejects invalid phone with message", () => {
    const result = createEntityUserSchema.safeParse({
      ...validEntityCreate,
      phoneNumber: "abc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === UsersValidationMessages.INVALID_PHONE,
        ),
      ).toBe(true);
    }
  });

  it("rejects short phone", () => {
    const result = createEntityUserSchema.safeParse({
      ...validEntityCreate,
      phoneNumber: "98765",
    });
    expect(result.success).toBe(false);
  });

  it("rejects junk WhatsApp", () => {
    const result = updateEntityUserSchema.safeParse({
      name: "Jane",
      emailId: "jane@example.com",
      phoneNumber: "9876543210",
      whatsappNumber: "not-a-phone",
      designation: "",
      isActive: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === UsersValidationMessages.INVALID_PHONE,
        ),
      ).toBe(true);
    }
  });

  it("accepts valid WhatsApp", () => {
    const parsed = updateEntityUserSchema.parse({
      name: "Jane",
      emailId: "jane@example.com",
      phoneNumber: "9876543210",
      whatsappNumber: "9123456780",
      designation: null,
      isActive: true,
    });
    expect(parsed.whatsappNumber).toBe("9123456780");
  });

  it("ignores username on update", () => {
    const parsed = updateEntityUserSchema.parse({
      name: "Jane",
      userLoginName: "jane-renamed",
      emailId: "jane@example.com",
      phoneNumber: "9876543210",
      whatsappNumber: "",
      designation: "",
      isActive: true,
    });
    expect("userLoginName" in parsed).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = createEntityUserSchema.safeParse({
      ...validEntityCreate,
      emailId: "not-an-email",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === UsersValidationMessages.INVALID_EMAIL,
        ),
      ).toBe(true);
    }
  });
});

describe("staff user schemas", () => {
  const validStaff = {
    name: "Admin",
    userLoginName: "admin1",
    emailId: "admin@example.com",
    phoneNumber: "9876543210",
    whatsappNumber: "",
    designation: "KAM",
    role: "admin" as const,
    isActive: true,
  };

  it("requires name, email, phone, role, and username", () => {
    const result = createStaffUserSchema.safeParse({
      ...validStaff,
      name: "",
      emailId: "",
      phoneNumber: "",
      role: "",
      userLoginName: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(UsersValidationMessages.NAME_REQUIRED);
      expect(messages).toContain(UsersValidationMessages.EMAIL_REQUIRED);
      expect(messages).toContain(UsersValidationMessages.PHONE_REQUIRED);
      expect(messages).toContain(UsersValidationMessages.ROLE_REQUIRED);
      expect(messages).toContain(UsersValidationMessages.USERNAME_REQUIRED);
    }
  });

  it("accepts create without initialPassword", () => {
    const parsed = createStaffUserSchema.parse(validStaff);
    expect(parsed.userLoginName).toBe("admin1");
    expect(
      "initialPassword" in parsed ? parsed.initialPassword : undefined,
    ).toBeUndefined();
  });

  it("accepts other optional fields as empty", () => {
    const parsed = createStaffUserSchema.parse({
      ...validStaff,
      designation: "",
      whatsappNumber: "",
      bidderId: null,
      clientIds: [],
    });
    expect(parsed.designation).toBeNull();
    expect(parsed.whatsappNumber).toBeNull();
  });

  it("rejects invalid optional phone", () => {
    const result = updateStaffUserSchema.safeParse({
      name: "Admin",
      emailId: "admin@example.com",
      phoneNumber: "123",
      whatsappNumber: "",
      designation: "",
      role: "kam",
      isActive: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === UsersValidationMessages.INVALID_PHONE,
        ),
      ).toBe(true);
    }
  });

  it("ignores username on update", () => {
    const parsed = updateStaffUserSchema.parse({
      name: "Admin",
      userLoginName: "admin-renamed",
      emailId: "admin@example.com",
      phoneNumber: "9876543210",
      whatsappNumber: "",
      designation: "",
      role: "kam",
      isActive: true,
    });
    expect("userLoginName" in parsed).toBe(false);
  });

  it("rejects invalid optional email", () => {
    const result = createStaffUserSchema.safeParse({
      ...validStaff,
      emailId: "bad",
    });
    expect(result.success).toBe(false);
  });
});

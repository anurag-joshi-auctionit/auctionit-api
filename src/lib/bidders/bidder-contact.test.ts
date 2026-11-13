import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

const { getActiveBidderContact } = await import("./bidder-contact.js");

function mockSelectRows(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  selectMock.mockReturnValueOnce(chain);
}

describe("getActiveBidderContact", () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it("returns null when no active user", async () => {
    mockSelectRows([]);
    await expect(getActiveBidderContact(10)).resolves.toBeNull();
  });

  it("returns null when email is empty", async () => {
    mockSelectRows([
      {
        userId: 1,
        name: "Ada",
        email: "  ",
        phone: "9876543210",
        whatsapp: null,
      },
    ]);
    await expect(getActiveBidderContact(10)).resolves.toBeNull();
  });

  it("returns contact for an active user with email", async () => {
    mockSelectRows([
      {
        userId: 55,
        name: "Ada",
        email: " ada@example.com ",
        phone: "9876543210",
        whatsapp: null,
      },
    ]);
    await expect(getActiveBidderContact(10)).resolves.toEqual({
      userId: 55,
      name: "Ada",
      email: "ada@example.com",
      phone: "9876543210",
      whatsapp: null,
    });
  });
});

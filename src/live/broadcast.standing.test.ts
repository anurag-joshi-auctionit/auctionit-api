import { describe, expect, it } from "vitest";
import { participantStanding } from "./participant-standing.js";

describe("participantStanding", () => {
  it("returns none when the lot has no winner (only/winning bid removed)", () => {
    expect(
      participantStanding({
        winnerBidderId: null,
        bidderId: 10,
        hasLiveBid: false,
      }),
    ).toBe("none");
  });

  it("returns winning for the current winner", () => {
    expect(
      participantStanding({
        winnerBidderId: 10,
        bidderId: 10,
        hasLiveBid: true,
      }),
    ).toBe("winning");
  });

  it("returns outbid when a non-winner still has a live bid", () => {
    expect(
      participantStanding({
        winnerBidderId: 20,
        bidderId: 10,
        hasLiveBid: true,
      }),
    ).toBe("outbid");
  });

  it("returns none when a former winner has no live bid left", () => {
    expect(
      participantStanding({
        winnerBidderId: 20,
        bidderId: 10,
        hasLiveBid: false,
      }),
    ).toBe("none");
  });
});

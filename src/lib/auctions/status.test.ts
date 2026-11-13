import { describe, expect, it } from "vitest";
import {
  AUCTION_SCHEDULE_TIME_ZONE,
  auctionDateIsoForInstant,
  canArchiveAuction,
  canEditAuctionContent,
  canEditAuctionSettingsFields,
  canEditLotContent,
  canEditExecutionContent,
  canEditSealedBidWindow,
  canRestoreAuction,
  canUnpublishAuction,
  isSealedBidWindowOpen,
  deriveNoBidLotStatus,
  deriveScheduleBucket,
  deriveAdminPhase,
  earliestLotStart,
  fromIstWallClock,
  hasEarliestLotStartPassed,
  isAllLotsEnded,
  isAuctionDateToday,
  isAuctionScheduleEnded,
  latestLotEnd,
  parseLotDateTime,
} from "./status.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Asia/Kolkata wall-clock HH:mm:ss for an instant (lot time column form). */
function timeOfDayIst(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: AUCTION_SCHEDULE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")!.value;
  const mm = parts.find((p) => p.type === "minute")!.value;
  const ss = parts.find((p) => p.type === "second")!.value;
  return `${hh}:${mm}:${ss}`;
}

function shiftIstCalendarDays(isoAuctionDate: string, deltaDays: number): string {
  const day = isoAuctionDate.slice(0, 10);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}T00:00:00.000Z`;
}

describe("parseLotDateTime (Asia/Kolkata)", () => {
  it("treats HH:mm:ss as IST wall clock, not process local", () => {
    // 2026-07-31 16:00 IST == 2026-07-31T10:30:00.000Z
    const parsed = parseLotDateTime("16:00:00", "2026-07-31T00:00:00.000Z");
    expect(parsed?.toISOString()).toBe("2026-07-31T10:30:00.000Z");
  });
});

describe("isAuctionDateToday", () => {
  it("is true when the auction date is today's IST calendar day", () => {
    const now = new Date("2026-07-31T10:00:00.000Z");
    expect(isAuctionDateToday(auctionDateIsoForInstant(now), now)).toBe(true);
  });

  it("is false when the auction date is a different calendar day", () => {
    const now = new Date("2026-07-31T10:00:00.000Z");
    const yesterday = shiftIstCalendarDays(auctionDateIsoForInstant(now), -1);
    const tomorrow = shiftIstCalendarDays(auctionDateIsoForInstant(now), 1);
    expect(isAuctionDateToday(yesterday, now)).toBe(false);
    expect(isAuctionDateToday(tomorrow, now)).toBe(false);
  });

  it("is false for an unparsable auction date", () => {
    expect(isAuctionDateToday("not-a-date")).toBe(false);
  });
});

describe("deriveScheduleBucket", () => {
  it("returns live when earliest lot start is today, in the past, and schedule not over", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    const pastStart = new Date(now.getTime() - 3_600_000);
    const futureEnd = new Date(now.getTime() + 3_600_000);
    expect(
      deriveScheduleBucket(
        auctionDate,
        [
          {
            lotStartTime: timeOfDayIst(pastStart),
            lotEndTime: timeOfDayIst(futureEnd),
          },
        ],
        now,
      ),
    ).toBe("live");
  });

  it("returns null for a past date even if lots would still look open by wall clock", () => {
    const today = auctionDateIsoForInstant();
    const yesterday = shiftIstCalendarDays(today, -1);
    expect(
      deriveScheduleBucket(yesterday, [
        { lotStartTime: "00:00:00", lotEndTime: "23:59:00" },
      ]),
    ).toBeNull();
  });

  it("returns upcoming when earliest lot start is later today", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    const later = fromIstWallClock(
      Number(auctionDate.slice(0, 4)),
      Number(auctionDate.slice(5, 7)) - 1,
      Number(auctionDate.slice(8, 10)),
      23,
      0,
      0,
    );
    if (later.getTime() <= now.getTime()) return;

    expect(
      deriveScheduleBucket(
        auctionDate,
        [{ lotStartTime: "23:00:00", lotEndTime: "23:30:00" }],
        now,
      ),
    ).toBe("upcoming");
  });

  it("returns future when auction day is after today", () => {
    const today = auctionDateIsoForInstant();
    const future = shiftIstCalendarDays(today, 2);
    expect(
      deriveScheduleBucket(future, [
        { lotStartTime: "10:00:00", lotEndTime: "12:00:00" },
      ]),
    ).toBe("future");
  });

  it("returns null when there are no active lots even on auction day", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    expect(deriveScheduleBucket(auctionDate, [], now)).toBeNull();
  });

  it("uses earliest lot start, not auction_date time-of-day", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    const later = fromIstWallClock(
      Number(auctionDate.slice(0, 4)),
      Number(auctionDate.slice(5, 7)) - 1,
      Number(auctionDate.slice(8, 10)),
      23,
      0,
      0,
    );
    if (later.getTime() <= now.getTime()) return;

    expect(
      deriveScheduleBucket(
        auctionDate,
        [{ lotStartTime: "23:00:00", lotEndTime: "23:45:00" }],
        now,
      ),
    ).toBe("upcoming");
  });

  it("returns null when auction calendar day is yesterday", () => {
    const today = auctionDateIsoForInstant();
    const yesterday = shiftIstCalendarDays(today, -1);
    expect(
      deriveScheduleBucket(yesterday, [
        { lotStartTime: "10:00:00", lotEndTime: "12:00:00" },
      ]),
    ).toBeNull();
  });

  it("returns null when auction day is yesterday and lots have no end times", () => {
    const today = auctionDateIsoForInstant();
    const yesterday = shiftIstCalendarDays(today, -1);
    expect(
      deriveScheduleBucket(yesterday, [
        { lotStartTime: "10:00:00", lotEndTime: null },
      ]),
    ).toBeNull();
  });

  it("returns null when today all lot ends are in the past", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    const pastStart = new Date(now.getTime() - 7_200_000);
    const pastEnd = new Date(now.getTime() - 3_600_000);
    expect(
      deriveScheduleBucket(
        auctionDate,
        [
          {
            lotStartTime: timeOfDayIst(pastStart),
            lotEndTime: timeOfDayIst(pastEnd),
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("stays live when scheduled end passed but extended_end_time is still ahead", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    const pastStart = new Date(now.getTime() - 7_200_000);
    const pastEnd = new Date(now.getTime() - 3_600_000);
    const extendedEnd = new Date(now.getTime() + 600_000);
    const ymd = auctionDate.slice(0, 10);
    const extendedWall = `${ymd} ${timeOfDayIst(extendedEnd)}`;
    expect(
      deriveScheduleBucket(
        auctionDate,
        [
          {
            lotStartTime: timeOfDayIst(pastStart),
            lotEndTime: timeOfDayIst(pastEnd),
            lotExtendedEndTime: extendedWall,
          },
        ],
        now,
      ),
    ).toBe("live");
  });
});

describe("isAuctionScheduleEnded", () => {
  it("is true when latest lot end is in the past", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    const pastEnd = new Date(now.getTime() - 3_600_000);
    expect(
      isAuctionScheduleEnded(
        [{ lotStartTime: "10:00:00", lotEndTime: timeOfDayIst(pastEnd) }],
        now,
        auctionDate,
      ),
    ).toBe(true);
  });

  it("is false when latest lot end is still in the future", () => {
    const now = new Date();
    const auctionDate = auctionDateIsoForInstant(now);
    const futureEnd = new Date(now.getTime() + 3_600_000);
    expect(
      isAuctionScheduleEnded(
        [{ lotStartTime: "10:00:00", lotEndTime: timeOfDayIst(futureEnd) }],
        now,
        auctionDate,
      ),
    ).toBe(false);
  });

  it("falls back to end of auction day when no end times", () => {
    const today = auctionDateIsoForInstant();
    const yesterday = shiftIstCalendarDays(today, -1);
    expect(
      isAuctionScheduleEnded(
        [{ lotStartTime: "10:00:00", lotEndTime: null }],
        new Date(),
        yesterday,
      ),
    ).toBe(true);
  });
});

describe("earliestLotStart / latestLotEnd", () => {
  it("picks earliest start and latest end as IST wall-clock instants", () => {
    const auctionDate = "2026-07-31T00:00:00.000Z";
    const start = earliestLotStart(
      [
        { lotStartTime: "14:00:00", lotEndTime: "15:00:00" },
        { lotStartTime: "10:00:00", lotEndTime: "18:00:00" },
      ],
      auctionDate,
    );
    expect(start.toISOString()).toBe("2026-07-31T04:30:00.000Z"); // 10:00 IST
    const end = latestLotEnd(
      [
        { lotStartTime: "14:00:00", lotEndTime: "15:00:00" },
        { lotStartTime: "10:00:00", lotEndTime: "18:00:00" },
      ],
      auctionDate,
    );
    expect(end?.toISOString()).toBe("2026-07-31T12:30:00.000Z"); // 18:00 IST
  });

  it("prefers extended_end_time over scheduled end_time", () => {
    const auctionDate = "2026-07-31T00:00:00.000Z";
    const end = latestLotEnd(
      [
        {
          lotStartTime: "10:00:00",
          lotEndTime: "12:00:00",
          lotExtendedEndTime: "2026-07-31 14:30:00",
        },
      ],
      auctionDate,
    );
    expect(end?.toISOString()).toBe("2026-07-31T09:00:00.000Z"); // 14:30 IST
  });
});

describe("hasEarliestLotStartPassed", () => {
  it("is false before the earliest lot start", () => {
    const auctionDate = "2026-07-31T00:00:00.000Z";
    // 09:00 IST
    const now = new Date("2026-07-31T03:30:00.000Z");
    expect(
      hasEarliestLotStartPassed(
        [
          { lotStartTime: "10:00:00", lotEndTime: "12:00:00" },
          { lotStartTime: "14:00:00", lotEndTime: "16:00:00" },
        ],
        auctionDate,
        now,
      ),
    ).toBe(false);
  });

  it("is true after the earliest lot start", () => {
    const auctionDate = "2026-07-31T00:00:00.000Z";
    // 10:00:01 IST
    const now = new Date("2026-07-31T04:30:01.000Z");
    expect(
      hasEarliestLotStartPassed(
        [
          { lotStartTime: "10:00:00", lotEndTime: "12:00:00" },
          { lotStartTime: "14:00:00", lotEndTime: "16:00:00" },
        ],
        auctionDate,
        now,
      ),
    ).toBe(true);
  });

  it("blocks publish after IST lot start even when UTC clock is still before HH:mm", () => {
    // Lot starts 16:00 IST (= 10:30 UTC). At 12:00 UTC a naive UTC parse of
    // "16:00" would still look future; IST-aware check must reject.
    const auctionDate = "2026-07-31T00:00:00.000Z";
    const now = new Date("2026-07-31T12:00:00.000Z"); // 17:30 IST
    expect(
      hasEarliestLotStartPassed(
        [{ lotStartTime: "16:00:00", lotEndTime: "16:30:00" }],
        auctionDate,
        now,
      ),
    ).toBe(true);
  });

  it("is false when there are no active lot starts (empty or missing times)", () => {
    const auctionDate = "2020-01-15T00:00:00.000Z";
    const now = fromIstWallClock(2020, 0, 15, 11, 0, 0);
    expect(hasEarliestLotStartPassed([], auctionDate, now)).toBe(false);
    expect(
      hasEarliestLotStartPassed(
        [{ lotStartTime: null, lotEndTime: null }],
        auctionDate,
        now,
      ),
    ).toBe(false);
  });
});

describe("isAllLotsEnded", () => {
  it("returns false when no lot end times", () => {
    expect(isAllLotsEnded([])).toBe(false);
  });
});

describe("deriveAdminPhase", () => {
  it("maps creation statuses", () => {
    expect(deriveAdminPhase("draft")).toBe("creation");
    expect(deriveAdminPhase("archived")).toBe("creation");
  });

  it("maps published to execution", () => {
    expect(deriveAdminPhase("published")).toBe("execution");
  });

  it("maps closed to settlement", () => {
    expect(deriveAdminPhase("closed")).toBe("settlement");
  });
});

describe("canArchiveAuction / canRestoreAuction / canEditAuctionContent", () => {
  const futureDate = "2099-06-15T00:00:00.000Z";
  const lotsFuture = [
    { lotStartTime: "10:00:00", lotEndTime: "12:00:00" },
  ];

  it("allows archive from draft always", () => {
    expect(
      canArchiveAuction({
        status: "draft",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(true);
  });

  it("allows archive from published before earliest lot start", () => {
    expect(
      canArchiveAuction({
        status: "published",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(true);
  });

  it("blocks archive from published after earliest lot start", () => {
    const auctionDate = "2020-01-15T00:00:00.000Z";
    const now = fromIstWallClock(2020, 0, 15, 11, 0, 0);
    expect(
      canArchiveAuction({
        status: "published",
        auctionDate,
        lots: [{ lotStartTime: "10:00:00", lotEndTime: "12:00:00" }],
        now,
      }),
    ).toBe(false);
  });

  it("allows archive from published with zero lots even on auction day", () => {
    const auctionDate = "2020-01-15T00:00:00.000Z";
    const now = fromIstWallClock(2020, 0, 15, 11, 0, 0);
    expect(
      canArchiveAuction({
        status: "published",
        auctionDate,
        lots: [],
        now,
      }),
    ).toBe(true);
  });

  it("blocks archive from archived and closed", () => {
    expect(
      canArchiveAuction({
        status: "archived",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(false);
    expect(
      canArchiveAuction({
        status: "closed",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(false);
  });

  it("allows restore from archived only", () => {
    expect(canRestoreAuction("archived")).toBe(true);
    expect(canRestoreAuction("draft")).toBe(false);
    expect(canRestoreAuction("published")).toBe(false);
  });

  it("allows edit in draft always and published before lot start", () => {
    expect(
      canEditAuctionContent({
        status: "draft",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(true);
    expect(
      canEditAuctionContent({
        status: "published",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(true);
  });

  it("allows edit when published with zero lots even after auction-day midnight", () => {
    const auctionDate = "2020-01-15T00:00:00.000Z";
    const now = fromIstWallClock(2020, 0, 15, 11, 0, 0);
    expect(
      canEditAuctionContent({
        status: "published",
        auctionDate,
        lots: [],
        now,
      }),
    ).toBe(true);
  });

  it("blocks edit after earliest lot start when published", () => {
    const auctionDate = "2020-01-15T00:00:00.000Z";
    const now = fromIstWallClock(2020, 0, 15, 11, 0, 0);
    expect(
      canEditAuctionContent({
        status: "published",
        auctionDate,
        lots: [{ lotStartTime: "10:00:00", lotEndTime: "12:00:00" }],
        now,
      }),
    ).toBe(false);
  });

  it("blocks edit when archived or closed", () => {
    expect(
      canEditAuctionContent({
        status: "archived",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(false);
    expect(
      canEditAuctionContent({
        status: "closed",
        auctionDate: futureDate,
        lots: lotsFuture,
      }),
    ).toBe(false);
  });
});

describe("canEditAuctionSettingsFields", () => {
  it("is true for draft, archived and published", () => {
    expect(canEditAuctionSettingsFields("draft")).toBe(true);
    expect(canEditAuctionSettingsFields("archived")).toBe(true);
    expect(canEditAuctionSettingsFields("published")).toBe(true);
  });

  it("is false once closed", () => {
    expect(canEditAuctionSettingsFields("closed")).toBe(false);
  });
});

describe("canEditLotContent", () => {
  it("is true for draft, archived and published", () => {
    expect(canEditLotContent("draft")).toBe(true);
    expect(canEditLotContent("archived")).toBe(true);
    expect(canEditLotContent("published")).toBe(true);
  });

  it("is false once closed", () => {
    expect(canEditLotContent("closed")).toBe(false);
  });

  it("is true once closed when the lot has been reopened", () => {
    expect(canEditLotContent("closed", true)).toBe(true);
  });
});

describe("canEditExecutionContent", () => {
  it("is true for published", () => {
    expect(canEditExecutionContent("published")).toBe(true);
  });

  it("is false once closed", () => {
    expect(canEditExecutionContent("closed")).toBe(false);
  });

  it("is false for draft and archived", () => {
    expect(canEditExecutionContent("draft")).toBe(false);
    expect(canEditExecutionContent("archived")).toBe(false);
  });
});

describe("deriveNoBidLotStatus", () => {
  const base = {
    noBidExtensionCountMax: 5,
    noBidExtensionCount: 0,
    isNoBidExtension: true,
  };

  it("is Active when no-bid extension is enabled and max count is positive", () => {
    expect(deriveNoBidLotStatus(base)).toBe("Active");
  });

  it("is Stopped for a reopened lot even when otherwise active", () => {
    expect(deriveNoBidLotStatus({ ...base, isReopened: true })).toBe(
      "Stopped",
    );
  });

  it("is Stopped when max count is 0", () => {
    expect(deriveNoBidLotStatus({ ...base, noBidExtensionCountMax: 0 })).toBe(
      "Stopped",
    );
  });

  it("is Stopped when max count is null", () => {
    expect(
      deriveNoBidLotStatus({ ...base, noBidExtensionCountMax: null }),
    ).toBe("Stopped");
  });

  it("is Stopped when the running counter has reached the max count", () => {
    expect(
      deriveNoBidLotStatus({
        ...base,
        noBidExtensionCountMax: 3,
        noBidExtensionCount: 3,
      }),
    ).toBe("Stopped");
  });

  it("is Stopped when the lot's no-bid extension flag is off", () => {
    expect(deriveNoBidLotStatus({ ...base, isNoBidExtension: false })).toBe(
      "Stopped",
    );
  });
});

describe("schedule gates with a sealed-bid window", () => {
  const auctionDate = "2020-01-15T00:00:00.000Z";
  const lots = [{ lotStartTime: "15:00:00", lotEndTime: "16:00:00" }];
  const sealedBidStartAt = fromIstWallClock(2020, 0, 15, 10, 0, 0);

  it("stays editable before the sealed window opens", () => {
    const now = fromIstWallClock(2020, 0, 15, 9, 59, 0);
    const input = { status: "published" as const, auctionDate, lots, sealedBidStartAt, now };
    expect(canEditAuctionContent(input)).toBe(true);
    expect(canArchiveAuction(input)).toBe(true);
  });

  it("locks once the sealed window opens, before any lot starts", () => {
    const now = fromIstWallClock(2020, 0, 15, 10, 0, 0);
    const input = { status: "published" as const, auctionDate, lots, sealedBidStartAt, now };
    expect(canEditAuctionContent(input)).toBe(false);
    expect(canArchiveAuction(input)).toBe(false);
  });

  it("locks a sealed-only auction with no lot times once the window opens", () => {
    const now = fromIstWallClock(2020, 0, 15, 11, 0, 0);
    expect(
      canEditAuctionContent({
        status: "published",
        auctionDate,
        lots: [{ lotStartTime: null, lotEndTime: null }],
        sealedBidStartAt,
        now,
      }),
    ).toBe(false);
  });
});


describe("sealed + live and sealed-only edit gates", () => {
  const auctionDate = "2020-01-15T00:00:00.000Z";
  const lots = [{ lotStartTime: "15:00:00", lotEndTime: "16:00:00" }];
  const sealedBidStartAt = fromIstWallClock(2020, 0, 15, 10, 0, 0);
  const sealedBidEndAt = fromIstWallClock(2020, 0, 15, 12, 0, 0);
  const base = {
    status: "published" as const,
    auctionDate,
    lots,
    sealedBidStartAt,
    sealedBidEndAt,
  };
  const at = (h: number, m = 0) => fromIstWallClock(2020, 0, 15, h, m, 0);

  it("is editable before the window opens", () => {
    const input = { ...base, now: at(9, 59) };
    expect(canEditAuctionContent(input)).toBe(true);
    expect(canEditSealedBidWindow(input)).toBe(true);
    expect(canUnpublishAuction(input)).toBe(true);
    expect(isSealedBidWindowOpen(input)).toBe(false);
  });

  it("locks content while the window is open, but sealed settings stay editable", () => {
    const input = { ...base, now: at(11) };
    expect(canEditAuctionContent(input)).toBe(false);
    expect(canEditSealedBidWindow(input)).toBe(true);
    expect(canUnpublishAuction(input)).toBe(false);
    expect(isSealedBidWindowOpen(input)).toBe(true);
  });

  it("reopens content after the window closes, until the first lot starts", () => {
    const input = { ...base, now: at(12, 30) };
    expect(canEditAuctionContent(input)).toBe(true);
    expect(isSealedBidWindowOpen(input)).toBe(false);
    expect(canEditSealedBidWindow(input)).toBe(true);
    expect(canUnpublishAuction(input)).toBe(false);
  });

  it("locks again once the first lot starts", () => {
    expect(canEditAuctionContent({ ...base, now: at(15, 1) })).toBe(false);
  });

  it("only lets published auctions move to draft", () => {
    expect(canUnpublishAuction({ ...base, status: "draft" as never, now: at(9) })).toBe(false);
  });
});

describe("sealed window settings stay editable while draft/published", () => {
  const sealedBidStartAt = fromIstWallClock(2020, 0, 15, 10, 0, 0);
  const sealedBidEndAt = fromIstWallClock(2020, 0, 15, 12, 0, 0);
  const closedAt = fromIstWallClock(2020, 0, 15, 13, 0, 0);

  it.each(["draft", "published"] as const)(
    "stays editable regardless of the window's clock state (%s)",
    (status) => {
      expect(
        canEditSealedBidWindow({
          status,
          auctionDate: "2020-01-15T00:00:00.000Z",
          sealedBidStartAt,
          sealedBidEndAt,
          now: closedAt,
        }),
      ).toBe(true);
    },
  );

  it.each(["closed", "archived"] as const)(
    "is locked once the auction is %s",
    (status) => {
      expect(
        canEditSealedBidWindow({
          status,
          auctionDate: "2020-01-15T00:00:00.000Z",
          sealedBidStartAt,
          sealedBidEndAt,
          now: closedAt,
        }),
      ).toBe(false);
    },
  );
});

export class LiftingLotNotFoundError extends Error {
  constructor(public readonly lotId: string) {
    super(`Lifting lot not found: ${lotId}`);
    this.name = "LiftingLotNotFoundError";
  }
}

export class LiftingClientValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "LiftingClientValidationError";
  }
}

export class LiftingClientLogNotFoundError extends Error {
  constructor(
    public readonly lotId: string,
    public readonly logId: string,
  ) {
    super(`Lifting log not found: ${lotId}/${logId}`);
    this.name = "LiftingClientLogNotFoundError";
  }
}

export function parseLotId(id: string): number {
  const sep = id.indexOf(":");
  const raw = sep > 0 ? id.slice(sep + 1) : id;
  const lotId = Number(raw.trim());
  if (!Number.isInteger(lotId) || lotId <= 0) {
    throw new LiftingLotNotFoundError(id);
  }
  return lotId;
}

export function formatLotId(lotId: number): string {
  return String(lotId);
}

export function parseAuctionId(raw: string): number | null {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(":");
  const idPart = sep > 0 ? trimmed.slice(sep + 1) : trimmed;
  const auctionId = Number(idPart);
  if (!Number.isInteger(auctionId) || auctionId <= 0) return null;
  return auctionId;
}

export function parseAuctionIdsFromComma(raw: string | undefined): number[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((part) => parseAuctionId(part))
    .filter((id): id is number => id != null);
}

// Room names are the shared addressing scheme for every live push channel:
// Socket.IO rooms and the SSE hub both key subscribers by these strings, so a
// broadcast written once reaches watchers on either transport.

export function auctionPublicRoom(auctionId: number): string {
  return `auction:${auctionId}:public`;
}

export function auctionAdminRoom(auctionId: number): string {
  return `auction:${auctionId}:admin`;
}

/** Client portal room — winner identity, no bidder standing. */
export function auctionClientRoom(auctionId: number): string {
  return `auction:${auctionId}:client`;
}

/** Legacy room prefix — still accepted for getActiveAuctionIds parsing. */
export function isAuctionRoom(room: string): boolean {
  return (
    room.startsWith("auction:") &&
    (room.endsWith(":public") ||
      room.endsWith(":admin") ||
      room.endsWith(":client") ||
      /^auction:\d+$/.test(room))
  );
}

export function parseAuctionIdFromRoom(room: string): number | null {
  const m = /^auction:(\d+)(?::(?:public|admin|client))?$/.exec(room);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

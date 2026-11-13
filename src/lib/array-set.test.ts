import { describe, expect, it, vi } from "vitest";
import {
  mergeIntSets,
  unionIntArrayColumn,
  type SqlExecutor,
} from "./array-set.js";

describe("mergeIntSets", () => {
  it("dedupes, drops non-positive, and sorts", () => {
    expect(mergeIntSets([3, 1, 1], [2, 1, 0, -1, 4])).toEqual([1, 2, 3, 4]);
  });

  it("handles null/undefined existing", () => {
    expect(mergeIntSets(null, [2, 2, 1])).toEqual([1, 2]);
    expect(mergeIntSets(undefined, [])).toEqual([]);
  });
});

describe("unionIntArrayColumn", () => {
  it("no-ops on empty ids without executing", async () => {
    const execute = vi.fn();
    const executor: SqlExecutor = { execute };
    const changed = await unionIntArrayColumn(executor, {
      table: "clients",
      column: "bidders",
      rowId: 10,
      ids: [],
      updatedBy: 1,
    });
    expect(changed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns true when rowCount > 0", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const executor: SqlExecutor = { execute };
    const changed = await unionIntArrayColumn(executor, {
      table: "clients",
      column: "materials",
      rowId: 5,
      ids: [9, 9, 3],
      updatedBy: 2,
    });
    expect(changed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBeTruthy();
  });

  it("returns false when rowCount is 0 (already subset)", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const executor: SqlExecutor = { execute };
    const changed = await unionIntArrayColumn(executor, {
      table: "bidders",
      column: "materials",
      rowId: 7,
      ids: [1],
    });
    expect(changed).toBe(false);
  });
});

describe("mergeIntSets idempotence", () => {
  it("re-union of same ids is stable", () => {
    const once = mergeIntSets([1, 2], [3]);
    expect(mergeIntSets(once, [3, 2, 1])).toEqual(once);
  });
});

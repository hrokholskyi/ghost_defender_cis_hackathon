import { beforeEach, describe, expect, it } from "vitest";
import { freshStore } from "@/lib/__tests__/helpers";
import { getSnapshot } from "@/lib/snapshot";
import { resetState } from "@/lib/store";
import type { StateSnapshot } from "@/lib/types";
import { acceptSnapshot } from "../accept-snapshot";

beforeEach(freshStore);

function snap(serverId: string, seq: number): StateSnapshot {
  return { ...getSnapshot(), serverId, seq };
}

describe("acceptSnapshot", () => {
  it("accepts the first snapshot", () => {
    expect(acceptSnapshot(null, snap("a", 0))).toBe(true);
  });

  it("accepts a higher seq from the same server", () => {
    expect(acceptSnapshot(snap("a", 5), snap("a", 6))).toBe(true);
  });

  it("rejects a lower seq from the same server", () => {
    expect(acceptSnapshot(snap("a", 5), snap("a", 4))).toBe(false);
  });

  it("accepts a lower seq from a different server", () => {
    expect(acceptSnapshot(snap("a", 50), snap("b", 0))).toBe(true);
  });

  it("rejects a missing or malformed snapshot", () => {
    const prev = snap("a", 5);
    for (const next of [null, undefined, "x", 42, {}, { seq: "6", serverId: "a" }, { seq: 6 }, { seq: Number.NaN, serverId: "b" }, { seq: 6, serverId: "" }]) {
      expect(acceptSnapshot(prev, next)).toBe(false);
      expect(acceptSnapshot(null, next)).toBe(false);
    }
  });
});

describe("serverId", () => {
  it("stays the same across a simulator reset", () => {
    const before = getSnapshot().serverId;
    expect(before).toMatch(/\S/);
    resetState();
    expect(getSnapshot().serverId).toBe(before);
  });
});

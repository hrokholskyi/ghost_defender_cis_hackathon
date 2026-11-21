import { describe, expect, it } from "vitest";
import { RISK_CONFIG, RISK_WEIGHTS } from "@/lib/config";
import {
  actionForLevel,
  assessRisk,
  isUnusualAmount,
  levelForScore,
  median,
  scoreSignals,
  type RiskFacts,
} from "@/lib/risk-engine";
import type { RiskSignalId } from "@/lib/types";

const LOGIN = "2026-03-15T02:00:00+04:00";

function baseFacts(overrides: Partial<RiskFacts> = {}): RiskFacts {
  return {
    sessionId: "sess-x",
    loginAt: LOGIN,
    device: { label: "iPhone 15 Pro", platform: "iOS", trustedAtLogin: true },
    network: { city: "Dubai", country: "AE" },
    homeCountry: "AE",
    sim: { swapConfirmed: false, swappedAt: null },
    beneficiariesAddedInSession: [],
    typicalAmount: 3000,
    ...overrides,
  };
}

const knownPayment = {
  amount: 3000,
  beneficiaryName: "Al Noor Properties",
  beneficiarySettledCount: 3,
  beneficiaryCreatedInSession: false,
  requestedAt: "2026-03-15T02:03:00+04:00",
};

function ids(facts: RiskFacts): RiskSignalId[] {
  return assessRisk(facts, undefined, LOGIN).signals.map((s) => s.id);
}

describe("risk engine weights", () => {
  it("scores a clean session at 0", () => {
    const a = assessRisk(baseFacts({ payment: knownPayment }), undefined, LOGIN);
    expect(a.score).toBe(0);
    expect(a.level).toBe("LOW");
    expect(a.action).toBe("ALLOW");
    expect(a.signals).toEqual([]);
  });

  it("serves the demo weights and disclaimer", () => {
    expect(RISK_CONFIG.weights).toEqual({
      UNKNOWN_DEVICE: 15,
      RECENT_SIM_SWAP: 25,
      UNUSUAL_NETWORK: 10,
      NEW_BENEFICIARY: 15,
      UNUSUAL_AMOUNT: 20,
      RAPID_SEQUENCE: 15,
    });
    expect(RISK_CONFIG.thresholds).toEqual({ elevated: 30, high: 60, critical: 80 });
    expect(RISK_CONFIG.disclaimer).toBe("Demo weights and thresholds. Not a calibrated model.");
  });

  const cases: Array<[RiskSignalId, Partial<RiskFacts>]> = [
    ["UNKNOWN_DEVICE", { device: { label: "Samsung Galaxy A54", platform: "Android", trustedAtLogin: false } }],
    ["RECENT_SIM_SWAP", { sim: { swapConfirmed: true, swappedAt: "2026-03-15T01:15:00+04:00" } }],
    ["UNUSUAL_NETWORK", { network: { city: "Lagos", country: "NG" } }],
    ["NEW_BENEFICIARY", { payment: { ...knownPayment, beneficiarySettledCount: 0 } }],
    ["UNUSUAL_AMOUNT", { payment: { ...knownPayment, amount: 85000 } }],
  ];
  it.each(cases)("%s alone adds its weight", (id, overrides) => {
    const a = assessRisk(baseFacts({ payment: knownPayment, ...overrides }), undefined, LOGIN);
    expect(a.signals.map((s) => s.id)).toEqual([id]);
    expect(a.score).toBe(RISK_WEIGHTS[id]);
    expect(a.signals[0].points).toBe(RISK_WEIGHTS[id]);
    expect(a.signals[0].evidence.length).toBeGreaterThan(10);
  });

  it("RAPID_SEQUENCE adds 15 on top of NEW_BENEFICIARY", () => {
    const a = assessRisk(
      baseFacts({
        beneficiariesAddedInSession: [{ name: "Orion Trading FZE", createdAt: "2026-03-15T02:02:00+04:00" }],
        payment: { ...knownPayment, beneficiarySettledCount: 0, beneficiaryCreatedInSession: true },
      }),
      undefined,
      LOGIN,
    );
    expect(a.signals.map((s) => [s.id, s.points])).toEqual([
      ["NEW_BENEFICIARY", 15],
      ["RAPID_SEQUENCE", 15],
    ]);
    expect(a.score).toBe(30);
  });

  it("adding a beneficiary in the session fires NEW_BENEFICIARY without a payment", () => {
    expect(
      ids(baseFacts({ beneficiariesAddedInSession: [{ name: "X", createdAt: "2026-03-15T02:02:00+04:00" }] })),
    ).toEqual(["NEW_BENEFICIARY"]);
  });
});

describe("risk engine levels", () => {
  it.each([
    [0, "LOW", "ALLOW"],
    [29, "LOW", "ALLOW"],
    [30, "ELEVATED", "STEP_UP"],
    [59, "ELEVATED", "STEP_UP"],
    [60, "HIGH", "HOLD"],
    [79, "HIGH", "HOLD"],
    [80, "CRITICAL", "HOLD_AND_RESTRICT"],
    [100, "CRITICAL", "HOLD_AND_RESTRICT"],
  ] as const)("score %i is %s -> %s", (score, level, action) => {
    expect(levelForScore(score)).toBe(level);
    expect(actionForLevel(level)).toBe(action);
  });

  it("maps real signal sums across the boundaries", () => {
    expect(scoreSignals(["UNKNOWN_DEVICE", "NEW_BENEFICIARY"]).level).toBe("ELEVATED"); // 30
    expect(scoreSignals(["RECENT_SIM_SWAP"]).level).toBe("LOW"); // 25
    expect(scoreSignals(["UNKNOWN_DEVICE", "RECENT_SIM_SWAP", "UNUSUAL_AMOUNT"]).level).toBe("HIGH"); // 60
    expect(scoreSignals(["UNKNOWN_DEVICE", "RECENT_SIM_SWAP", "NEW_BENEFICIARY"]).level).toBe("ELEVATED"); // 55
    expect(
      scoreSignals(["UNKNOWN_DEVICE", "RECENT_SIM_SWAP", "NEW_BENEFICIARY", "UNUSUAL_AMOUNT"]).level,
    ).toBe("HIGH"); // 75
    expect(
      scoreSignals(["UNKNOWN_DEVICE", "RECENT_SIM_SWAP", "NEW_BENEFICIARY", "UNUSUAL_AMOUNT", "UNUSUAL_NETWORK"])
        .level,
    ).toBe("CRITICAL"); // 85
  });
});

describe("risk engine totals and rules", () => {
  it("lists signals in canonical order with running totals", () => {
    const a = assessRisk(
      baseFacts({
        device: { label: "Samsung Galaxy A54", platform: "Android", trustedAtLogin: false },
        sim: { swapConfirmed: true, swappedAt: "2026-03-15T01:15:00+04:00" },
        network: { city: "Lagos", country: "NG" },
        beneficiariesAddedInSession: [{ name: "Orion Trading FZE", createdAt: "2026-03-15T02:02:00+04:00" }],
        payment: { ...knownPayment, amount: 85000, beneficiarySettledCount: 0, beneficiaryCreatedInSession: true },
      }),
      undefined,
      LOGIN,
    );
    expect(a.signals.map((s) => s.id)).toEqual([
      "UNKNOWN_DEVICE",
      "RECENT_SIM_SWAP",
      "UNUSUAL_NETWORK",
      "NEW_BENEFICIARY",
      "UNUSUAL_AMOUNT",
      "RAPID_SEQUENCE",
    ]);
    expect(a.signals.map((s) => s.cumulative)).toEqual([15, 40, 50, 65, 85, 100]);
    expect(a.score).toBe(100);
    expect(a.signals.find((s) => s.id === "UNUSUAL_AMOUNT")?.evidence).toBe(
      "Transfer of AED 85,000 is 28.3x the typical AED 3,000",
    );
  });

  it("uses 5 x median as the amount boundary", () => {
    expect(median([2400, 2750, 2900, 3000, 3000, 3100, 3350, 3600])).toBe(3000);
    expect(isUnusualAmount(14999, 3000)).toBe(false);
    expect(isUnusualAmount(15000, 3000)).toBe(true);
    expect(ids(baseFacts({ payment: { ...knownPayment, amount: 14999 } }))).toEqual([]);
    expect(ids(baseFacts({ payment: { ...knownPayment, amount: 15000 } }))).toEqual(["UNUSUAL_AMOUNT"]);
  });

  it("counts a SIM swap only in the 60 minutes before login", () => {
    const swap = (swappedAt: string) => ids(baseFacts({ sim: { swapConfirmed: true, swappedAt } }));
    expect(swap("2026-03-15T01:00:00+04:00")).toEqual(["RECENT_SIM_SWAP"]); // 60 min
    expect(swap("2026-03-15T00:59:00+04:00")).toEqual([]); // 61 min
    expect(swap("2026-03-15T02:05:00+04:00")).toEqual([]); // after login
  });

  it("counts a rapid sequence only within 10 minutes of login", () => {
    const rapid = (requestedAt: string) =>
      ids(
        baseFacts({
          beneficiariesAddedInSession: [{ name: "Orion", createdAt: LOGIN }],
          payment: { ...knownPayment, beneficiarySettledCount: 0, beneficiaryCreatedInSession: true, requestedAt },
        }),
      );
    expect(rapid("2026-03-15T02:10:00+04:00")).toContain("RAPID_SEQUENCE");
    expect(rapid("2026-03-15T02:11:00+04:00")).not.toContain("RAPID_SEQUENCE");
  });

  it("compares the exact time against the windows, not rounded minutes", () => {
    const swap = (swappedAt: string) => ids(baseFacts({ sim: { swapConfirmed: true, swappedAt } }));
    expect(swap("2026-03-15T01:00:00+04:00")).toEqual(["RECENT_SIM_SWAP"]); // exactly 60 min
    expect(swap("2026-03-15T00:59:59+04:00")).toEqual([]); // 60 min 1 s
    expect(swap("2026-03-15T00:59:31+04:00")).toEqual([]); // 60 min 29 s, rounds to 60
    expect(swap("2026-03-15T02:00:00+04:00")).toEqual(["RECENT_SIM_SWAP"]); // at login

    const rapid = (requestedAt: string) =>
      ids(
        baseFacts({
          beneficiariesAddedInSession: [{ name: "Orion", createdAt: LOGIN }],
          payment: { ...knownPayment, beneficiarySettledCount: 0, beneficiaryCreatedInSession: true, requestedAt },
        }),
      );
    expect(rapid("2026-03-15T02:10:00+04:00")).toContain("RAPID_SEQUENCE"); // exactly 10 min
    expect(rapid("2026-03-15T02:10:01+04:00")).not.toContain("RAPID_SEQUENCE"); // 10 min 1 s
    expect(rapid("2026-03-15T02:10:29+04:00")).not.toContain("RAPID_SEQUENCE"); // 10 min 29 s, rounds to 10
    expect(rapid("2026-03-15T02:00:00+04:00")).toContain("RAPID_SEQUENCE"); // at login
    expect(rapid("2026-03-15T01:59:59+04:00")).not.toContain("RAPID_SEQUENCE"); // before login
  });

  it("keeps signals sticky with their first detection time", () => {
    const first = assessRisk(
      baseFacts({ payment: { ...knownPayment, amount: 85000 } }),
      undefined,
      "2026-03-15T02:03:00+04:00",
    );
    const second = assessRisk(baseFacts({ payment: knownPayment }), first, "2026-03-15T02:20:00+04:00");
    expect(second.score).toBe(20);
    expect(second.signals[0].detectedAt).toBe("2026-03-15T02:03:00+04:00");
    expect(second.signals[0].evidence).toBe(first.signals[0].evidence);
  });
});

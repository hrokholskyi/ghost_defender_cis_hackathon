/**
 * Demo configuration of the transparent point model and the simulator.
 * Demo weights and thresholds. Not a calibrated model.
 */
import type { RiskConfig, RiskSignalId } from "@/lib/types";

export const RISK_WEIGHTS: Record<RiskSignalId, number> = {
  UNKNOWN_DEVICE: 15,
  RECENT_SIM_SWAP: 25,
  UNUSUAL_NETWORK: 10,
  NEW_BENEFICIARY: 15,
  UNUSUAL_AMOUNT: 20,
  RAPID_SEQUENCE: 15,
};

/** Lower bound of each level: 0-29 LOW, 30-59 ELEVATED, 60-79 HIGH, 80-100 CRITICAL. */
export const RISK_THRESHOLDS = { elevated: 30, high: 60, critical: 80 } as const;

export const RISK_DISCLAIMER = "Demo weights and thresholds. Not a calibrated model.";

export const RISK_SIGNAL_LABELS: Record<RiskSignalId, string> = {
  UNKNOWN_DEVICE: "Unknown device",
  RECENT_SIM_SWAP: "Recent SIM swap",
  UNUSUAL_NETWORK: "Unusual network",
  NEW_BENEFICIARY: "New beneficiary",
  UNUSUAL_AMOUNT: "Unusual amount",
  RAPID_SEQUENCE: "Rapid sequence",
};

/** A SIM swap counts when it happened at most this many minutes before the session login. */
export const SIM_SWAP_WINDOW_MINUTES = 60;
/** A transfer counts as rapid when requested at most this many minutes after login. */
export const RAPID_SEQUENCE_WINDOW_MINUTES = 10;
/** A transfer is unusual at or above this multiple of the typical (median settled) amount. */
export const UNUSUAL_AMOUNT_MULTIPLIER = 5;

export const RISK_CONFIG: RiskConfig = {
  weights: RISK_WEIGHTS,
  thresholds: { ...RISK_THRESHOLDS },
  disclaimer: RISK_DISCLAIMER,
};

/** All simulated timestamps carry the Dubai offset. */
export const TIME_ZONE_OFFSET = "+04:00";
export const TIME_ZONE_OFFSET_MINUTES = 4 * 60;

/** Default simulated clock after a plain reset. */
export const DEFAULT_START_AT = "2026-03-15T09:00:00+04:00";

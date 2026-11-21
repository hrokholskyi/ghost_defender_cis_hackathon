/**
 * Zod schemas for everything the model hands back: the final verdict and the
 * create_incident input. Model output is untrusted, so it is validated here
 * before any of it reaches the bank core.
 */
import { z } from "zod";
import type { CreateIncidentInput, InvestigationVerdict, RiskAction, RiskLevel } from "@/lib/types";

export const RISK_ACTIONS = ["ALLOW", "STEP_UP", "HOLD", "HOLD_AND_RESTRICT"] as const satisfies readonly RiskAction[];
export const RISK_LEVELS = ["LOW", "ELEVATED", "HIGH", "CRITICAL"] as const satisfies readonly RiskLevel[];
export const ASSESSMENTS = [
  "LIKELY_ACCOUNT_TAKEOVER",
  "SUSPICIOUS",
  "LIKELY_LEGITIMATE",
] as const satisfies readonly InvestigationVerdict["assessment"][];

/** Verdict as submitted by the model. `incidentId` is filled in by code, never by the model. */
export const submittedVerdictSchema = z.object({
  assessment: z.enum(ASSESSMENTS),
  summary: z.string().trim().min(1).max(1200),
  evidence: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  recommendedAction: z.enum(RISK_ACTIONS),
});
export type SubmittedVerdict = z.infer<typeof submittedVerdictSchema>;

export const createIncidentInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  severity: z.enum(RISK_LEVELS),
  reasons: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
}) satisfies z.ZodType<CreateIncidentInput>;

/** First validation problem in plain words, for a fallback reason. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid payload";
  const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
  return `${path}: ${issue.message}`;
}

/** House style: no em or en dashes in text shown to the jury. */
export function plainDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, " - ");
}

/** Input validation for the public API. */
import { z } from "zod";
import { DomainError } from "@/lib/errors";

const isoDateTime = z
  .string()
  .refine((s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)), {
    message: "Expected an ISO 8601 date-time",
  });

export const networkSchema = z.object({
  ip: z.string().min(1).max(64),
  city: z.string().min(1).max(80),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, "Expected an ISO 3166-1 alpha-2 country code"),
});

export const loginSchema = z.object({
  deviceId: z.string().min(1).max(64),
  device: z
    .object({
      label: z.string().min(1).max(80),
      platform: z.enum(["iOS", "Android"]),
    })
    .optional(),
  network: networkSchema,
  at: isoDateTime.optional(),
});

export const simSwapSchema = z.object({
  swappedAt: isoDateTime,
  at: isoDateTime.optional(),
});

export const addBeneficiarySchema = z.object({
  name: z.string().trim().min(1).max(80),
  iban: z.string().trim().min(8).max(42),
  at: isoDateTime.optional(),
});

export const transferSchema = z.object({
  beneficiaryId: z.string().min(1).max(64),
  amount: z.number().positive().finite().max(10_000_000),
  at: isoDateTime.optional(),
});

export const verificationResponseSchema = z.object({
  response: z.enum(["CONFIRM", "DENY"]),
});

export const scenarioIdSchema = z.enum(["A", "B", "C"]);

/** Parses input or throws a 400 DomainError with a readable message. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new DomainError("INVALID_REQUEST", message || "Invalid request");
  }
  return result.data;
}

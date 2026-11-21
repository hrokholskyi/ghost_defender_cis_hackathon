/** Input validation for the public API. */
import { z } from "zod";
import { DomainError } from "@/lib/errors";
import { isValidIso } from "@/lib/time";

/** Strict ISO 8601 date-time with Z or an offset, between the years 2000 and 2099. */
export const isoDateTime = z.string().max(40).refine(isValidIso, {
  message: "Expected an ISO 8601 date-time such as 2026-03-15T09:00:00+04:00, between the years 2000 and 2099",
});

/** Amounts are whole fils (multiples of 0.01). Float noise such as 0.1 + 0.2 is rounded to the cent. */
const MAX_TRANSFER_AMOUNT = 10_000_000;
const amount = z
  .number()
  .finite()
  .positive()
  .max(MAX_TRANSFER_AMOUNT)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 && Math.round(n * 100) >= 1, {
    message: "Expected an amount in whole fils (a multiple of 0.01)",
  })
  .transform((n) => Math.round(n * 100) / 100);

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
  amount,
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

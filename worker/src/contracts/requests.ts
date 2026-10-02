import { z } from "zod";
import type { CreateAliasInput, PatchAliasInput } from "./api";

// Validate JSON shape here. Ownership, quotas, reserved names and verified
// destinations remain in the shared domain helpers and authenticated routes.
export const createAliasSchema: z.ZodType<CreateAliasInput> = z.object({
  domain_id: z.number(), local_part: z.string(),
  destination: z.string().optional(), label: z.string().nullable().optional(),
});
export const patchAliasSchema: z.ZodType<PatchAliasInput> = z.object({
  active: z.number().optional(), destination: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
});
export const createDestinationSchema = z.object({ email: z.string() });

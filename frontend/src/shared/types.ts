import { z } from "zod";

// ---------- Enums ----------

export const feedTypeSchema = z.enum(["breast_milk", "formula", "solids", "water"]);
export type FeedType = z.infer<typeof feedTypeSchema>;

export const feedUnitSchema = z.enum(["ml", "g"]);
export type FeedUnit = z.infer<typeof feedUnitSchema>;

export const poopConsistencySchema = z.enum(["watery", "soft", "formed", "hard"]);
export type PoopConsistency = z.infer<typeof poopConsistencySchema>;

export const entryTypeSchema = z.enum(["feed", "sleep", "poop", "appointment"]);
export type EntryType = z.infer<typeof entryTypeSchema>;

// ---------- Wire entities ----------

const isoString = z.string().min(1);

export const feedEntrySchema = z.object({
  id: z.number().int().positive(),
  feed_type: feedTypeSchema,
  quantity: z.number().positive(),
  unit: feedUnitSchema,
  occurred_at: isoString,
  created_at: isoString,
  updated_at: isoString,
});
export type FeedEntry = z.infer<typeof feedEntrySchema>;

export const sleepEntrySchema = z.object({
  id: z.number().int().positive(),
  start_at: isoString,
  end_at: isoString,
  duration_minutes: z.number().int().nonnegative(),
  created_at: isoString,
  updated_at: isoString,
});
export type SleepEntry = z.infer<typeof sleepEntrySchema>;

export const poopEntrySchema = z.object({
  id: z.number().int().positive(),
  occurred_at: isoString,
  consistency: poopConsistencySchema,
  created_at: isoString,
  updated_at: isoString,
});
export type PoopEntry = z.infer<typeof poopEntrySchema>;

export const appointmentNoteSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().min(1).max(2000),
  added_at: isoString,
});
export type AppointmentNote = z.infer<typeof appointmentNoteSchema>;

export const appointmentEntrySchema = z.object({
  id: z.number().int().positive(),
  scheduled_at: isoString,
  notes: z.array(appointmentNoteSchema),
  created_at: isoString,
  updated_at: isoString,
});
export type AppointmentEntry = z.infer<typeof appointmentEntrySchema>;

// ---------- List wrappers ----------

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function listResponse<T extends z.ZodTypeAny>(item: T) {
  return z.object({ date: dateString, items: z.array(item) });
}

export const feedListResponseSchema = listResponse(feedEntrySchema);
export type FeedListResponse = z.infer<typeof feedListResponseSchema>;

export const sleepListResponseSchema = listResponse(sleepEntrySchema);
export type SleepListResponse = z.infer<typeof sleepListResponseSchema>;

export const poopListResponseSchema = listResponse(poopEntrySchema);
export type PoopListResponse = z.infer<typeof poopListResponseSchema>;

export const appointmentListResponseSchema = listResponse(appointmentEntrySchema);
export type AppointmentListResponse = z.infer<typeof appointmentListResponseSchema>;

// ---------- Agent write envelope ----------

export const agentWriteRequestSchema = z.object({
  message: z.string().min(1),
  reference_date: dateString.optional(),
});
export type AgentWriteRequest = z.infer<typeof agentWriteRequestSchema>;

const anyEntrySchema = z.union([
  feedEntrySchema,
  sleepEntrySchema,
  poopEntrySchema,
  appointmentEntrySchema,
]);

const correlationId = z.string().min(1);

export const agentCreatedSchema = z.object({
  outcome: z.literal("created"),
  entry_type: entryTypeSchema,
  entry: anyEntrySchema,
  agent_message: z.string(),
  correlation_id: correlationId,
  session_id: z.string().optional(),
});

export const agentUpdatedSchema = z.object({
  outcome: z.literal("updated"),
  entry_type: entryTypeSchema,
  entry: anyEntrySchema,
  agent_message: z.string(),
  correlation_id: correlationId,
  session_id: z.string().optional(),
  unchanged: z.boolean().optional(),
});

export const agentDeletedSchema = z.object({
  outcome: z.literal("deleted"),
  entry_type: entryTypeSchema,
  entry: anyEntrySchema,
  agent_message: z.string(),
  correlation_id: correlationId,
  session_id: z.string().optional(),
});

export const targetCandidateSchema = z.object({
  entry_type: entryTypeSchema,
  entry_id: z.number().int().positive(),
  preview: z.string().optional(),
});

export const agentClarificationSchema = z.object({
  outcome: z.literal("clarification_requested"),
  agent_message: z.string(),
  suggested_candidates: z.array(targetCandidateSchema).optional(),
  correlation_id: correlationId,
  session_id: z.string().optional(),
});

export const agentRejectedSchema = z.object({
  outcome: z.literal("rejected"),
  agent_message: z.string(),
  correlation_id: correlationId,
  session_id: z.string().optional(),
});

export const agentWriteResponseSchema = z.discriminatedUnion("outcome", [
  agentCreatedSchema,
  agentUpdatedSchema,
  agentDeletedSchema,
  agentClarificationSchema,
  agentRejectedSchema,
]);
export type AgentWriteResponse = z.infer<typeof agentWriteResponseSchema>;

// ---------- Chat-entry (direct LLM dispatch, feature 005) ----------

export const chatEntryRequestSchema = z.object({
  message: z.string().min(1).max(8192),
});
export type ChatEntryRequest = z.infer<typeof chatEntryRequestSchema>;

const chatEntryOutcomeSchema = z.enum([
  "created",
  "updated",
  "deleted",
  "clarification_requested",
  "error",
]);

const chatEntryErrorReasonSchema = z.enum([
  "malformed_llm_output",
  "unknown_tool",
  "invalid_tool_arguments",
  "llm_unavailable",
  "message_too_large",
  "validation_error",
]);

const chatEntrySuggestedCandidateSchema = z.object({
  entry_type: entryTypeSchema,
  entry_id: z.number().int().positive(),
  summary: z.string().optional(),
});

export const chatEntryResponseSchema = z.object({
  outcome: chatEntryOutcomeSchema,
  agent_message: z.string(),
  entry_type: entryTypeSchema.nullable().optional(),
  entry_id: z.number().int().positive().nullable().optional(),
  selected_tool: z.string().nullable().optional(),
  error_reason: chatEntryErrorReasonSchema.nullable().optional(),
  suggested_candidates: z.array(chatEntrySuggestedCandidateSchema).nullable().optional(),
  correlation_id: correlationId,
  session_id: z.string().min(1),
});
export type ChatEntryResponse = z.infer<typeof chatEntryResponseSchema>;

// ---------- Errors ----------

export const errorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  correlation_id: correlationId,
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

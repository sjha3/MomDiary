import {
  type AgentWriteRequest,
  type AgentWriteResponse,
  type AppointmentListResponse,
  type ChatEntryRequest,
  type ChatEntryResponse,
  type FeedListResponse,
  type PoopListResponse,
  type SleepListResponse,
  agentWriteResponseSchema,
  appointmentListResponseSchema,
  chatEntryResponseSchema,
  errorBodySchema,
  feedListResponseSchema,
  poopListResponseSchema,
  sleepListResponseSchema,
} from "./types";
import { isoDate } from "./queryKeys";
import type { ZodSchema } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;

  constructor(opts: { status: number; code: string; message: string; correlationId: string }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.correlationId = opts.correlationId;
  }
}

function getBaseUrl(): string {
  const fromEnv = import.meta.env?.VITE_API_BASE_URL;
  return (fromEnv ?? "http://localhost:8000").replace(/\/$/, "");
}

function newCorrelationId(): string {
  const g = globalThis.crypto;
  if (g && typeof g.randomUUID === "function") return g.randomUUID();
  // RFC4122 v4 fallback
  const r = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${r()}-${r().slice(0, 4)}-4${r().slice(0, 3)}-8${r().slice(0, 3)}-${r()}${r().slice(0, 4)}`;
}

// Module-level chat session id. Set from the first `X-Session-ID` response
// header on /v1/entries and replayed on every subsequent request so the
// backend's in-memory SessionStore can thread conversation history into the
// agent (feature 003-chat-session-store).
let currentSessionId: string | null = null;

export function getSessionId(): string | null {
  return currentSessionId;
}

export function resetSessionId(): void {
  currentSessionId = null;
}

async function request<T>(
  path: string,
  init: RequestInit,
  schema: ZodSchema<T>,
): Promise<T> {
  const correlationId = newCorrelationId();
  const headers = new Headers(init.headers);
  headers.set("X-Correlation-ID", correlationId);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (currentSessionId && !headers.has("X-Session-ID")) {
    headers.set("X-Session-ID", currentSessionId);
  }

  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}${path}`, { ...init, headers });
  } catch (cause) {
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: cause instanceof Error ? cause.message : "Network error",
      correlationId,
    });
  }

  const returnedSessionId = response.headers.get("X-Session-ID");
  if (returnedSessionId) {
    currentSessionId = returnedSessionId;
  }

  const text = await response.text();
  const json = text ? safeParseJson(text) : undefined;

  if (!response.ok) {
    if (json) {
      const errBody = errorBodySchema.safeParse(json);
      if (errBody.success) {
        throw new ApiError({
          status: response.status,
          code: errBody.data.error,
          message: errBody.data.message,
          correlationId: errBody.data.correlation_id || correlationId,
        });
      }
    }
    throw new ApiError({
      status: response.status,
      code: "http_error",
      message: `HTTP ${response.status}`,
      correlationId,
    });
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      status: response.status,
      code: "schema_error",
      message: parsed.error.message,
      correlationId,
    });
  }
  return parsed.data;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const apiClient = {
  getFeeds: (date: Date): Promise<FeedListResponse> =>
    request(`/v1/feeds?date=${isoDate(date)}`, { method: "GET" }, feedListResponseSchema),
  getSleeps: (date: Date): Promise<SleepListResponse> =>
    request(`/v1/sleeps?date=${isoDate(date)}`, { method: "GET" }, sleepListResponseSchema),
  getPoops: (date: Date): Promise<PoopListResponse> =>
    request(`/v1/poops?date=${isoDate(date)}`, { method: "GET" }, poopListResponseSchema),
  getAppointments: (date: Date): Promise<AppointmentListResponse> =>
    request(
      `/v1/appointments?date=${isoDate(date)}`,
      { method: "GET" },
      appointmentListResponseSchema,
    ),
  postEntry: (body: AgentWriteRequest): Promise<AgentWriteResponse> =>
    request(`/v1/entries`, { method: "POST", body: JSON.stringify(body) }, agentWriteResponseSchema),
  postChatEntry: (body: ChatEntryRequest): Promise<ChatEntryResponse> =>
    request(`/v1/chatentry/`, { method: "POST", body: JSON.stringify(body) }, chatEntryResponseSchema),
};

export type ApiClient = typeof apiClient;

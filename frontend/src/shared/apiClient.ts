import {
  type AgentWriteRequest,
  type AgentWriteResponse,
  type AppointmentEntry,
  type AppointmentListResponse,
  type AppointmentCreate,
  type AppointmentUpdate,
  type Baby,
  type BabyCreate,
  type BabyListResponse,
  type BabyUpdate,
  type CurrentUser,
  type FeedCreate,
  type FeedEntry,
  type FeedListResponse,
  type FeedUpdate,
  type PoopEntry,
  type PoopListResponse,
  type PoopCreate,
  type PoopUpdate,
  type ResearchRequest,
  type ResearchResponse,
  type SetActiveBabyRequest,
  type SleepEntry,
  type SleepListResponse,
  type SleepCreate,
  type SleepUpdate,
  type UserPublic,
  type UserUpdate,
  agentWriteResponseSchema,
  appointmentEntrySchema,
  appointmentListResponseSchema,
  authMeSchema,
  babyListResponseSchema,
  babySchema,
  currentUserSchema,
  errorBodySchema,
  feedEntrySchema,
  feedListResponseSchema,
  okResponseSchema,
  poopEntrySchema,
  poopListResponseSchema,
  researchResponseSchema,
  sleepEntrySchema,
  sleepListResponseSchema,
} from "./types";
import { isoDate } from "./queryKeys";
import { z, type ZodSchema } from "zod";

const voidSchema = z.undefined();

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
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "");
  }
  // Hard fail in production builds — silently defaulting to localhost is the
  // #1 source of "the app loads but nothing works" deployments. In dev mode
  // (vite dev / vitest) localhost is the expected backend.
  if (import.meta.env?.PROD) {
    throw new Error(
      "VITE_API_BASE_URL is not set. Production builds must point at a real backend " +
        "(e.g. https://api.momdiary.example). Set it in .env.production or the build environment.",
    );
  }
  return "http://localhost:8000";
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

// Per-request active baby id sent as X-Active-Baby-Id (research §R7).
// React state mirrors `users.active_baby_id` and updates this via setter.
let activeBabyId: number | null = null;

export function getActiveBabyId(): number | null {
  return activeBabyId;
}

export function setActiveBabyId(id: number | null): void {
  if (activeBabyId !== id) {
    activeBabyId = id;
    // Switching baby == new conversation thread (research §R6).
    currentSessionId = null;
  }
}

// Subscribed by `useSession` so the app can react to auth loss (e.g.
// signOut() + redirect). Triggered on any 401 from the backend.
type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

// ----- Clerk bearer-token injection (feature 008) -----
// `main.tsx` mounts <ClerkTokenBridge/> which registers a token provider here
// on first render and re-registers on sign-out. The provider must return
// a JWT minted from the `momdiary-default` template (or null when signed-out).
type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider | null = null;
export function setTokenProvider(fn: TokenProvider | null): void {
  tokenProvider = fn;
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
  if (activeBabyId !== null && !headers.has("X-Active-Baby-Id")) {
    headers.set("X-Active-Baby-Id", String(activeBabyId));
  }
  if (tokenProvider && !headers.has("Authorization")) {
    try {
      const token = await tokenProvider();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    } catch {
      // Token mint failed (e.g. signed-out) — fall through; the request
      // will 401 and the unauthorized listeners will redirect.
    }
  }

  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      headers,
    });
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
    if (response.status === 401) {
      for (const fn of unauthorizedListeners) {
        try {
          fn();
        } catch {
          // listeners must not throw
        }
      }
    }
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
    // 204 No Content: callers using `voidSchema` accept undefined.
    if (response.status === 204 && (schema as unknown) === voidSchema) {
      return undefined as unknown as T;
    }
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
  // ---- auth (feature 008: Clerk JWT) ----
  /** `GET /v1/users/me` returns the flat `CurrentUserOut` projection. */
  me: (): Promise<CurrentUser> =>
    request(`/v1/users/me`, { method: "GET" }, currentUserSchema),
  updateMe: (body: UserUpdate): Promise<{ user: UserPublic }> =>
    request(
      `/v1/users/me`,
      { method: "PATCH", body: JSON.stringify(body) },
      authMeSchema,
    ),
  setActiveBaby: (body: SetActiveBabyRequest): Promise<{ user: UserPublic }> =>
    request(
      `/v1/users/me/active-baby`,
      { method: "POST", body: JSON.stringify(body) },
      authMeSchema,
    ),

  // ---- babies (feature 006) ----
  listBabies: (): Promise<BabyListResponse> =>
    request(`/v1/babies`, { method: "GET" }, babyListResponseSchema),
  createBaby: (body: BabyCreate): Promise<Baby> =>
    request(
      `/v1/babies`,
      { method: "POST", body: JSON.stringify(body) },
      babySchema,
    ),
  updateBaby: (id: number, body: BabyUpdate): Promise<Baby> =>
    request(
      `/v1/babies/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
      babySchema,
    ),
  deleteBaby: (id: number): Promise<{ ok: true }> =>
    request(
      `/v1/babies/${id}`,
      { method: "DELETE" },
      okResponseSchema,
    ),

  // ---- diary (existing) ----
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
  postResearch: (body: ResearchRequest): Promise<ResearchResponse> =>
    request(`/v1/research`, { method: "POST", body: JSON.stringify(body) }, researchResponseSchema),

  // ---- direct per-entry create (quick-log) ----
  createFeed: (body: FeedCreate): Promise<FeedEntry> =>
    request(`/v1/feeds`, { method: "POST", body: JSON.stringify(body) }, feedEntrySchema),
  createPoop: (body: PoopCreate): Promise<PoopEntry> =>
    request(`/v1/poops`, { method: "POST", body: JSON.stringify(body) }, poopEntrySchema),
  createSleep: (body: SleepCreate): Promise<SleepEntry> =>
    request(`/v1/sleeps`, { method: "POST", body: JSON.stringify(body) }, sleepEntrySchema),
  createAppointment: (body: AppointmentCreate): Promise<AppointmentEntry> =>
    request(
      `/v1/appointments`,
      { method: "POST", body: JSON.stringify(body) },
      appointmentEntrySchema,
    ),

  // ---- direct per-entry edit/delete ----
  updateFeed: (id: number, body: FeedUpdate): Promise<FeedEntry> =>
    request(`/v1/feeds/${id}`, { method: "PATCH", body: JSON.stringify(body) }, feedEntrySchema),
  deleteFeed: (id: number): Promise<void> =>
    request(`/v1/feeds/${id}`, { method: "DELETE" }, voidSchema),
  updateSleep: (id: number, body: SleepUpdate): Promise<SleepEntry> =>
    request(`/v1/sleeps/${id}`, { method: "PATCH", body: JSON.stringify(body) }, sleepEntrySchema),
  deleteSleep: (id: number): Promise<void> =>
    request(`/v1/sleeps/${id}`, { method: "DELETE" }, voidSchema),
  updatePoop: (id: number, body: PoopUpdate): Promise<PoopEntry> =>
    request(`/v1/poops/${id}`, { method: "PATCH", body: JSON.stringify(body) }, poopEntrySchema),
  deletePoop: (id: number): Promise<void> =>
    request(`/v1/poops/${id}`, { method: "DELETE" }, voidSchema),
  updateAppointment: (id: number, body: AppointmentUpdate): Promise<AppointmentEntry> =>
    request(
      `/v1/appointments/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
      appointmentEntrySchema,
    ),
  deleteAppointment: (id: number): Promise<void> =>
    request(`/v1/appointments/${id}`, { method: "DELETE" }, voidSchema),
};

export type ApiClient = typeof apiClient;

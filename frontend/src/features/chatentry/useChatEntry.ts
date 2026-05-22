import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useReducer } from "react";
import { ApiError, apiClient } from "@/shared/apiClient";
import { entryTypeToSection } from "@/shared/queryKeys";
import type { ChatEntryResponse } from "@/shared/types";
import { chatReducer } from "@/features/chat/reducer";
import { INITIAL_CHAT, type ChatMessage } from "@/features/chat/types";

function makeId(): string {
  const g = globalThis.crypto;
  if (g && typeof g.randomUUID === "function") return g.randomUUID();
  return `m-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Mirror of `useChat`, but wired to the direct-LLM `/v1/chatentry/`
 * endpoint (feature 005). Same UI contract (ChatMessage / chatReducer)
 * so the existing `ChatMessageList` renders both panels identically.
 */
export function useChatEntry() {
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT);
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (message: string) => apiClient.postChatEntry({ message }),
  });

  const setDraft = useCallback((value: string) => {
    dispatch({ type: "draft_changed", value });
  }, []);

  const submit = useCallback(
    async (rawDraft: string) => {
      const draft = rawDraft.trim();
      if (!draft || state.inFlight) return;

      const userMessage: ChatMessage = {
        id: makeId(),
        role: "caregiver",
        text: draft,
        ts: Date.now(),
      };
      dispatch({ type: "submit", userMessage });

      try {
        const response: ChatEntryResponse = await mutation.mutateAsync(draft);
        const assistantMessage: ChatMessage = {
          id: makeId(),
          role: "assistant",
          text: response.agent_message,
          ts: Date.now(),
          correlation_id: response.correlation_id,
          error:
            response.outcome === "error"
              ? {
                  code: response.error_reason ?? "error",
                  message: response.agent_message,
                }
              : undefined,
        };
        dispatch({ type: "success", assistantMessage });

        if (
          (response.outcome === "created" ||
            response.outcome === "updated" ||
            response.outcome === "deleted") &&
          response.entry_type
        ) {
          const section = entryTypeToSection[response.entry_type];
          if (section) {
            await qc.invalidateQueries({ queryKey: [section] });
          }
        }
      } catch (cause) {
        const apiErr = cause instanceof ApiError ? cause : null;
        const assistantMessage: ChatMessage = {
          id: makeId(),
          role: "assistant",
          text:
            "Something went wrong calling the direct-LLM endpoint — please try again. If it keeps happening, share the correlation ID below.",
          ts: Date.now(),
          correlation_id: apiErr?.correlationId,
          error: {
            code: apiErr?.code ?? "unknown_error",
            message: apiErr?.message ?? (cause instanceof Error ? cause.message : "Unknown error"),
          },
        };
        dispatch({ type: "error", assistantMessage, preservedDraft: draft });
      }
    },
    [state.inFlight, mutation, qc],
  );

  return {
    messages: state.messages,
    inFlight: state.inFlight,
    draft: state.draft,
    setDraft,
    submit,
  };
}

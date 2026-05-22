import { useCallback } from "react";
import { ChatMessageList } from "@/features/chat/ChatMessageList";
import { useChatEntry } from "./useChatEntry";

interface ChatEntryPanelProps {
  onHide?: () => void;
}

/**
 * Floating chat panel wired to `POST /v1/chatentry/` (feature 005).
 * Visually distinct from the primary `ChatPanel` so caregivers can
 * tell at a glance which dispatch path their message is taking.
 */
export function ChatEntryPanel({ onHide }: ChatEntryPanelProps = {}): JSX.Element {
  const { messages, inFlight, draft, setDraft, submit } = useChatEntry();

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void submit(draft);
    },
    [draft, submit],
  );

  return (
    <section
      aria-label="Direct-LLM chat"
      className="mx-auto flex w-full max-w-md flex-col gap-2 rounded-2xl border border-indigo-200 bg-indigo-50/70 p-3 shadow-lg lg:max-w-none"
    >
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-white text-xs">
          Direct LLM · /v1/chatentry/
        </span>
        {onHide ? (
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide direct-LLM chat"
            className="rounded px-2 py-0.5 text-slate-500 text-xs hover:bg-slate-100 hover:text-slate-900"
          >
            ✕ Hide
          </button>
        ) : null}
      </div>
      <ChatMessageList messages={messages} />
      {inFlight ? (
        <p className="text-slate-500 text-xs" role="status" aria-live="polite">
          Calling LLM…
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={inFlight}
          rows={2}
          placeholder="One-shot LLM dispatch — log a feed, sleep, diaper, or appointment…"
          className="flex-1 resize-none rounded border border-indigo-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit(draft);
            }
          }}
        />
        <button
          type="submit"
          disabled={inFlight || draft.trim().length === 0}
          className="rounded bg-indigo-600 px-3 py-2 text-sm text-white disabled:bg-indigo-300"
        >
          Send
        </button>
      </form>
    </section>
  );
}

export default ChatEntryPanel;

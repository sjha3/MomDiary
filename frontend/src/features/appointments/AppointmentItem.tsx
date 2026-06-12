import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient, ApiError } from "@/shared/apiClient";
import { confirm } from "@/shared/dialogs";
import { EntryActions } from "@/shared/EntryActions";
import { queryKeys } from "@/shared/queryKeys";
import {
  formatLocalTime,
  fromDatetimeLocalInputValue,
  toDatetimeLocalInputValue,
} from "@/shared/time";
import type { AppointmentEntry } from "@/shared/types";

interface AppointmentItemProps {
  entry: AppointmentEntry;
  date: Date;
}

export function AppointmentItem({ entry, date }: AppointmentItemProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const latestNote = entry.notes[entry.notes.length - 1];
  const extra = entry.notes.length - 1;
  const hasMore = extra > 0;

  const updateMut = useMutation({
    mutationFn: (body: { scheduled_at?: string }) =>
      apiClient.updateAppointment(entry.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.appointments(date) });
      setEditing(false);
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => apiClient.deleteAppointment(entry.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.appointments(date) }),
  });

  const busy = updateMut.isPending || deleteMut.isPending;

  async function handleDelete() {
    if (await confirm("Delete this appointment?")) deleteMut.mutate();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const scheduled = fromDatetimeLocalInputValue(String(fd.get("scheduled_at") ?? ""));
    updateMut.mutate({ scheduled_at: scheduled ?? undefined });
  }

  return (
    <li className="flex flex-col gap-1 rounded border border-appointment-50 bg-white p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-2xl text-appointment-700">
          {formatLocalTime(entry.scheduled_at)}
        </span>
        <div className="flex items-center gap-1">
          {hasMore ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse notes" : `Show ${extra} more notes`}
              className="rounded px-1 text-slate-500 text-xs hover:bg-slate-100 hover:text-slate-700"
            >
              {expanded ? `− hide` : `+${extra} more`}
            </button>
          ) : null}
          <EntryActions
            onEdit={() => setEditing((v) => !v)}
            onDelete={handleDelete}
            busy={busy}
          />
        </div>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-2">
          {entry.notes.map((n, i) => (
            <li
              key={n.id ?? i}
              className="whitespace-pre-wrap rounded border border-slate-100 bg-slate-50 p-2 text-slate-700 text-sm"
            >
              {n.body}
            </li>
          ))}
        </ul>
      ) : latestNote ? (
        <p className="line-clamp-2 text-slate-600 text-sm">{latestNote.body}</p>
      ) : null}
      {editing ? (
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-2 border-appointment-50 border-t pt-2 text-sm"
        >
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Scheduled for</span>
            <input
              type="datetime-local"
              name="scheduled_at"
              defaultValue={toDatetimeLocalInputValue(entry.scheduled_at)}
              required
              className="rounded border border-slate-300 p-1"
            />
          </label>
          {updateMut.isError ? (
            <p className="text-red-600 text-xs">
              {updateMut.error instanceof ApiError ? updateMut.error.message : "Save failed"}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded border border-slate-300 px-2 py-1 text-slate-600 text-xs hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-appointment-700 px-3 py-1 text-white text-xs hover:bg-appointment-700/90 disabled:opacity-50"
            >
              {updateMut.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : null}
      {deleteMut.isError ? (
        <p className="text-red-600 text-xs">
          {deleteMut.error instanceof ApiError ? deleteMut.error.message : "Delete failed"}
        </p>
      ) : null}
    </li>
  );
}

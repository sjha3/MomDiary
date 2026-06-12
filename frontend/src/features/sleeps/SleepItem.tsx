import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient, ApiError } from "@/shared/apiClient";
import { confirm } from "@/shared/dialogs";
import { EntryActions } from "@/shared/EntryActions";
import { queryKeys } from "@/shared/queryKeys";
import {
  formatDuration,
  formatLocalTime,
  fromDatetimeLocalInputValue,
  toDatetimeLocalInputValue,
} from "@/shared/time";
import type { SleepEntry } from "@/shared/types";

interface SleepItemProps {
  entry: SleepEntry;
  date: Date;
}

export function SleepItem({ entry, date }: SleepItemProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();

  const updateMut = useMutation({
    mutationFn: (body: { start_at?: string; end_at?: string }) =>
      apiClient.updateSleep(entry.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sleeps(date) });
      setEditing(false);
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => apiClient.deleteSleep(entry.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sleeps(date) }),
  });

  const busy = updateMut.isPending || deleteMut.isPending;

  async function handleDelete() {
    if (await confirm("Delete this sleep entry?")) deleteMut.mutate();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const start = fromDatetimeLocalInputValue(String(fd.get("start_at") ?? ""));
    const end = fromDatetimeLocalInputValue(String(fd.get("end_at") ?? ""));
    updateMut.mutate({
      start_at: start ?? undefined,
      end_at: end ?? undefined,
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded border border-sleep-50 bg-white p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold text-2xl text-sleep-700">
            {formatDuration(entry.duration_minutes)}
          </span>
          <span className="text-slate-600 text-sm">
            {formatLocalTime(entry.start_at)} – {formatLocalTime(entry.end_at)}
          </span>
        </div>
        <EntryActions
          onEdit={() => setEditing((v) => !v)}
          onDelete={handleDelete}
          busy={busy}
        />
      </div>
      {editing ? (
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-2 gap-2 border-sleep-50 border-t pt-2 text-sm"
        >
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Start</span>
            <input
              type="datetime-local"
              name="start_at"
              defaultValue={toDatetimeLocalInputValue(entry.start_at)}
              required
              className="rounded border border-slate-300 p-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">End</span>
            <input
              type="datetime-local"
              name="end_at"
              defaultValue={toDatetimeLocalInputValue(entry.end_at)}
              required
              className="rounded border border-slate-300 p-1"
            />
          </label>
          {updateMut.isError ? (
            <p className="col-span-2 text-red-600 text-xs">
              {updateMut.error instanceof ApiError ? updateMut.error.message : "Save failed"}
            </p>
          ) : null}
          <div className="col-span-2 flex justify-end gap-2 pt-1">
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
              className="rounded bg-sleep-700 px-3 py-1 text-white text-xs hover:bg-sleep-700/90 disabled:opacity-50"
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

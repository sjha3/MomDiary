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
import type { PoopConsistency, PoopEntry } from "@/shared/types";

const CONSISTENCY_LABEL: Record<PoopConsistency, string> = {
  watery: "Watery",
  soft: "Soft",
  formed: "Formed",
  hard: "Hard",
};

interface PoopItemProps {
  entry: PoopEntry;
  date: Date;
}

export function PoopItem({ entry, date }: PoopItemProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();

  const updateMut = useMutation({
    mutationFn: (body: { occurred_at?: string; consistency?: PoopConsistency }) =>
      apiClient.updatePoop(entry.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.poops(date) });
      setEditing(false);
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => apiClient.deletePoop(entry.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.poops(date) }),
  });

  const busy = updateMut.isPending || deleteMut.isPending;

  async function handleDelete() {
    if (await confirm("Delete this entry?")) deleteMut.mutate();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const occurred = fromDatetimeLocalInputValue(String(fd.get("occurred_at") ?? ""));
    updateMut.mutate({
      consistency: String(fd.get("consistency")) as PoopConsistency,
      occurred_at: occurred ?? undefined,
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded border border-poop-50 bg-white p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold text-2xl text-poop-700">
            {CONSISTENCY_LABEL[entry.consistency]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 text-xs">{formatLocalTime(entry.occurred_at)}</span>
          <EntryActions
            onEdit={() => setEditing((v) => !v)}
            onDelete={handleDelete}
            busy={busy}
          />
        </div>
      </div>
      {editing ? (
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-2 gap-2 border-poop-50 border-t pt-2 text-sm"
        >
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Consistency</span>
            <select
              name="consistency"
              defaultValue={entry.consistency}
              className="rounded border border-slate-300 p-1"
            >
              <option value="watery">Watery</option>
              <option value="soft">Soft</option>
              <option value="formed">Formed</option>
              <option value="hard">Hard</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Time</span>
            <input
              type="datetime-local"
              name="occurred_at"
              defaultValue={toDatetimeLocalInputValue(entry.occurred_at)}
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
              className="rounded bg-poop-700 px-3 py-1 text-white text-xs hover:bg-poop-700/90 disabled:opacity-50"
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

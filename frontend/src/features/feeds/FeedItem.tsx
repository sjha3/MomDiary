import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient, ApiError } from "@/shared/apiClient";
import { confirm } from "@/shared/dialogs";
import { EntryActions } from "@/shared/EntryActions";
import { queryKeys } from "@/shared/queryKeys";
import {
  fromDatetimeLocalInputValue,
  formatLocalTime,
  toDatetimeLocalInputValue,
} from "@/shared/time";
import type { FeedEntry, FeedType, FeedUnit } from "@/shared/types";

const FEED_LABEL: Record<FeedType, string> = {
  breast_milk: "breast milk",
  formula: "formula",
  solids: "solids",
  water: "water",
};

const UNIT_LABEL: Record<FeedUnit, string> = { ml: "ml", g: "g" };

interface FeedItemProps {
  entry: FeedEntry;
  date: Date;
}

export function FeedItem({ entry, date }: FeedItemProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();

  const updateMut = useMutation({
    mutationFn: (body: {
      feed_type?: FeedType;
      quantity?: number;
      unit?: FeedUnit;
      occurred_at?: string;
    }) => apiClient.updateFeed(entry.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.feeds(date) });
      setEditing(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => apiClient.deleteFeed(entry.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.feeds(date) }),
  });

  const busy = updateMut.isPending || deleteMut.isPending;

  async function handleDelete() {
    if (await confirm("Delete this feed entry?")) deleteMut.mutate();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const occurred = fromDatetimeLocalInputValue(String(fd.get("occurred_at") ?? ""));
    updateMut.mutate({
      feed_type: String(fd.get("feed_type")) as FeedType,
      quantity: Number(fd.get("quantity")),
      unit: String(fd.get("unit")) as FeedUnit,
      occurred_at: occurred ?? undefined,
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded border border-feed-50 bg-white p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold text-2xl text-feed-700">
            {entry.quantity} {UNIT_LABEL[entry.unit]}
          </span>
          <span className="text-slate-600 text-sm">{FEED_LABEL[entry.feed_type]}</span>
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
          className="grid grid-cols-2 gap-2 border-feed-50 border-t pt-2 text-sm"
        >
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Type</span>
            <select
              name="feed_type"
              defaultValue={entry.feed_type}
              className="rounded border border-slate-300 p-1"
            >
              <option value="breast_milk">Breast milk</option>
              <option value="formula">Formula</option>
              <option value="solids">Solids</option>
              <option value="water">Water</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Quantity</span>
            <input
              type="number"
              name="quantity"
              min="0"
              step="any"
              defaultValue={entry.quantity}
              required
              className="rounded border border-slate-300 p-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Unit</span>
            <select
              name="unit"
              defaultValue={entry.unit}
              className="rounded border border-slate-300 p-1"
            >
              <option value="ml">ml</option>
              <option value="g">g</option>
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
              className="rounded bg-feed-700 px-3 py-1 text-white text-xs hover:bg-feed-700/90 disabled:opacity-50"
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

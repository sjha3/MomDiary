import { useState } from "react";
import { setActiveBabyId } from "@/shared/apiClient";
import { confirm } from "@/shared/dialogs";
import type { Baby } from "@/shared/types";
import {
  useBabies,
  useCreateBabyMutation,
  useDeleteBabyMutation,
  useSetActiveBabyMutation,
} from "./useBabies";

/** Compact dropdown that lists babies and lets the caregiver switch. */
export function BabySwitcher(props: {
  activeBabyId: number | null;
}): JSX.Element {
  const { activeBabyId } = props;
  const babies = useBabies();
  const setActive = useSetActiveBabyMutation();
  const [showManage, setShowManage] = useState(false);

  const items = babies.data?.items ?? [];

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value);
    if (Number.isFinite(id) && id > 0 && id !== activeBabyId) {
      setActive.mutate(id);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="baby-switcher">
        Active baby
      </label>
      <select
        id="baby-switcher"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        value={activeBabyId ?? ""}
        onChange={onChange}
        disabled={setActive.isPending || items.length === 0}
      >
        {items.map((b) => (
          <option key={b.id} value={b.id}>
            {b.display_name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setShowManage((s) => !s)}
        aria-label="Manage babies"
        className="rounded bg-slate-200 px-2 py-1 text-sm hover:bg-slate-300"
      >
        ⚙
      </button>
      {showManage && (
        <ManageBabiesPanel
          babies={items}
          activeBabyId={activeBabyId}
          onClose={() => setShowManage(false)}
        />
      )}
    </div>
  );
}

function ManageBabiesPanel(props: {
  babies: Baby[];
  activeBabyId: number | null;
  onClose: () => void;
}): JSX.Element {
  const { babies, activeBabyId, onClose } = props;
  const create = useCreateBabyMutation();
  const del = useDeleteBabyMutation();
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    create.mutate(
      { display_name: name.trim(), date_of_birth: dob },
      {
        onSuccess: () => {
          setName("");
          setDob("");
        },
      },
    );
  };

  const onDelete = async (id: number) => {
    if (!(await confirm("Delete this baby? Diary entries remain but are inaccessible."))) {
      return;
    }
    del.mutate(id, {
      onSuccess: () => {
        if (activeBabyId === id) setActiveBabyId(null);
      },
    });
  };

  return (
    <div
      role="dialog"
      aria-label="Manage babies"
      className="absolute right-4 top-14 z-30 w-72 rounded border border-slate-300 bg-white p-3 shadow-lg"
    >
      <div className="flex items-center justify-between pb-2">
        <h2 className="text-sm font-semibold">Babies</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500">
          ✕
        </button>
      </div>
      <ul className="flex flex-col gap-1 border-b border-slate-200 pb-2 text-sm">
        {babies.map((b) => (
          <li key={b.id} className="flex items-center justify-between">
            <span>
              {b.display_name}
              {activeBabyId === b.id && (
                <span className="ml-1 text-xs text-emerald-600">(active)</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => onDelete(b.id)}
              className="text-xs text-red-600 hover:underline"
              disabled={del.isPending}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form className="flex flex-col gap-2 pt-2 text-sm" onSubmit={onAdd}>
        <input
          required
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1"
        />
        <input
          type="date"
          required
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1"
        />
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded bg-slate-900 px-2 py-1 text-white disabled:opacity-60"
        >
          {create.isPending ? "Adding…" : "Add baby"}
        </button>
      </form>
    </div>
  );
}

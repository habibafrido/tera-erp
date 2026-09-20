"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "./FormMessage";
import type { ActionResult } from "@/app/actions";

export type Field =
  | { kind: "text"; name: string; label: string; placeholder?: string; required?: boolean }
  | { kind: "number"; name: string; label: string; defaultValue?: number }
  | { kind: "check"; name: string; label: string; defaultChecked?: boolean }
  | { kind: "select"; name: string; label: string; options: { value: string; label: string }[] };

/**
 * Form data induk. Server action menerima FormData, jadi form asli HTML
 * dipakai apa adanya dan hasilnya ditampilkan tanpa berpindah halaman.
 */
export function MasterForm({
  fields, action, submitLabel,
}: {
  fields: Field[];
  action: (fd: FormData) => Promise<ActionResult>;
  submitLabel: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const r = await action(fd);
      setRes(r);
      if (r.ok) {
        formRef.current?.reset();
        router.refresh();
      }
    });
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
      <FormMessage res={res} />

      <div className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map((f) => {
          if (f.kind === "check") {
            return (
              <label key={f.name} className="flex items-center gap-2 self-end pb-2">
                <input
                  type="checkbox"
                  name={f.name}
                  defaultChecked={f.defaultChecked}
                  className="size-4 accent-action"
                />
                <span className="text-sm">{f.label}</span>
              </label>
            );
          }

          return (
            <label key={f.name} className="block">
              <span className="mb-1 block text-xs text-muted">{f.label}</span>
              {f.kind === "select" ? (
                <select name={f.name} className="field">
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="field"
                  name={f.name}
                  type={f.kind === "number" ? "number" : "text"}
                  required={f.kind === "text" ? f.required : undefined}
                  placeholder={f.kind === "text" ? f.placeholder : undefined}
                  defaultValue={f.kind === "number" ? f.defaultValue : undefined}
                />
              )}
            </label>
          );
        })}
      </div>

      <button className="btn" disabled={pending}>
        {pending ? "Menyimpan…" : submitLabel}
      </button>
    </form>
  );
}

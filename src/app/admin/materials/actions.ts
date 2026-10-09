"use server";

import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/authz";
import { materialByKey } from "@/lib/materials";
import { SettingsProblem, setMaterialEnabled } from "@/lib/settings";

/**
 * The owner's switches for which materials can be requested. The rules and the
 * audit live in `src/lib/settings.ts`; this reads a `FormData`, calls the
 * operation and redirects with a toast. The role is re-checked here: rendering
 * the page is not authorisation.
 */

function back(params: Record<string, string>): never {
  redirect(`/admin/materials?${new URLSearchParams(params).toString()}`);
}

export async function setMaterialAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  const enabled = formData.get("enabled") === "true";
  try {
    await setMaterialEnabled(admin, key, enabled);
    const label = materialByKey(key)?.label ?? key;
    back({ toast: `${label} is ${enabled ? "on" : "off"}` });
  } catch (error) {
    if (error instanceof SettingsProblem) back({ error: error.message });
    throw error;
  }
}

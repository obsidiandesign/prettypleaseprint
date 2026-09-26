import "server-only";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import type { Actor } from "@/lib/scope";

/**
 * Instance-wide switches, one row in `app_settings`.
 *
 * Read on every render that depends on them, not cached: there is one row
 * and a handful of users, and a switch the owner flips should take effect on
 * the next page load rather than after some TTL nobody remembers.
 */

export type Settings = { tipJarEnabled: boolean };

const DEFAULTS: Settings = { tipJarEnabled: false };

/** The current settings. A missing row is the defaults — nothing seeds it. */
export async function getSettings(): Promise<Settings> {
  const row = await db.appSettings.findUnique({
    where: { id: 1 },
    select: { tipJarEnabled: true },
  });
  return row ?? DEFAULTS;
}

export class SettingsProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsProblem";
  }
}

/**
 * Turn the tip jar on or off. Owner-only, re-checked here as well as at the
 * action, because rendering a page is not authorisation. Audited only when it
 * actually changes.
 */
export async function setTipJarEnabled(actor: Actor, enabled: boolean): Promise<void> {
  if (actor.role !== "admin") {
    throw new SettingsProblem("Only the printer owner changes settings.");
  }

  const before = await getSettings();
  if (before.tipJarEnabled === enabled) return;

  await db.appSettings.upsert({
    where: { id: 1 },
    create: { id: 1, tipJarEnabled: enabled },
    update: { tipJarEnabled: enabled },
  });
  await record({ action: enabled ? "tipjar.enabled" : "tipjar.disabled", actor });

  // Everything that renders a tip, or the form that asks for one.
  for (const path of ["/admin/benefits", "/upload", "/board", "/me"]) revalidatePath(path);
}

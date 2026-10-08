import "server-only";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import type { Actor } from "@/lib/scope";
import { materialPipelineId } from "@/lib/bambuddy";
import { ALWAYS_ON, MATERIALS, materialByKey, type Material } from "@/lib/materials";

/**
 * Instance-wide switches, one row in `app_settings`.
 *
 * Read on every render that depends on them, not cached: there is one row
 * and a handful of users, and a switch the owner flips should take effect on
 * the next page load rather than after some TTL nobody remembers.
 */

export type Settings = { tipJarEnabled: boolean; enabledMaterials: string[] };

const DEFAULTS: Settings = { tipJarEnabled: false, enabledMaterials: [] };

/** The current settings. A missing row is the defaults — nothing seeds it. */
export async function getSettings(): Promise<Settings> {
  const row = await db.appSettings.findUnique({
    where: { id: 1 },
    select: { tipJarEnabled: true, enabledMaterials: true },
  });
  return row ?? DEFAULTS;
}

/**
 * The materials a request can be made in right now: PLA, plus each one the
 * owner switched on *and* that has a Slicer Pipeline configured. A material
 * with no pipeline is never offered, switched on or not, because a request in
 * it could not be sliced.
 */
export async function printableMaterials(): Promise<Material[]> {
  const { enabledMaterials } = await getSettings();
  return MATERIALS.filter(
    (m) => m.key === ALWAYS_ON || (enabledMaterials.includes(m.key) && materialPipelineId(m.key) > 0),
  );
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

/**
 * Switch a material (other than PLA) on or off for new requests. Tickets
 * already made in it keep going: this only decides what can be asked for.
 */
export async function setMaterialEnabled(actor: Actor, key: string, enabled: boolean): Promise<void> {
  if (actor.role !== "admin") {
    throw new SettingsProblem("Only the printer owner changes settings.");
  }
  const material = materialByKey(key);
  if (!material || material.key === ALWAYS_ON) {
    throw new SettingsProblem("That isn't a material that can be switched.");
  }
  if (enabled && materialPipelineId(material.key) <= 0) {
    throw new SettingsProblem(`${material.label} has no Slicer Pipeline yet: set ${material.pipelineEnv} first.`);
  }

  const { enabledMaterials } = await getSettings();
  if (enabledMaterials.includes(key) === enabled) return;

  // Ensure the row exists, then change the one element in the database
  // itself, so two toggles at once can't overwrite each other's list.
  await db.appSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  await db.$executeRaw`UPDATE "app_settings" SET "enabledMaterials" = ${
    enabled
      ? Prisma.sql`array_append(array_remove("enabledMaterials", ${key}), ${key})`
      : Prisma.sql`array_remove("enabledMaterials", ${key})`
  }, "updatedAt" = now() WHERE "id" = 1`;
  await record({ action: enabled ? "material.enabled" : "material.disabled", actor, subject: material.key });

  for (const path of ["/admin/materials", "/upload", "/board", "/me"]) revalidatePath(path);
}

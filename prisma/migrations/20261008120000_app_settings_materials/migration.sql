-- Filament materials beyond PLA become switchable from /admin/materials.
--
-- WHAT THIS TOUCHES: adds one column to "app_settings", defaulting to an empty
-- list, so PLA stays the only material until the owner turns another on. No
-- row is rewritten in a way that changes behaviour; "story" is untouched.
ALTER TABLE "app_settings" ADD COLUMN "enabledMaterials" TEXT[] DEFAULT ARRAY[]::TEXT[];

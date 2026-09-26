-- The tip jar becomes an optional module, switched from /admin/benefits.
--
-- WHAT THIS TOUCHES: creates one new table and nothing else. No row is
-- written: a missing row reads as the defaults, so the tip jar starts off.
-- "story"."tip" and the "benefit" catalogue are untouched.
CREATE TABLE "app_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tipJarEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

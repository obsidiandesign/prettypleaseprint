-- AlterTable
-- Columns first, so the enum conversion below can write `errorMessage` on
-- legacy rows. `modelUrl` starts nullable and only becomes NOT NULL once
-- every existing row has been backfilled.
ALTER TABLE "story" DROP COLUMN "dims",
DROP COLUMN "fileSize",
DROP COLUMN "filename",
DROP COLUMN "mimeType",
DROP COLUMN "printSettings",
DROP COLUMN "storageKey",
ADD COLUMN     "archiveId" INTEGER,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "intakeStartedAt" TIMESTAMP(3),
ADD COLUMN     "libraryFileId" INTEGER,
ADD COLUMN     "modelUrl" TEXT,
ADD COLUMN     "neededBy" TIMESTAMP(3),
ADD COLUMN     "pipelineRunId" INTEGER,
ADD COLUMN     "queueItemId" INTEGER,
ADD COLUMN     "resolvedTitle" TEXT,
ADD COLUMN     "slicedLibraryFileId" INTEGER,
ADD COLUMN     "spoolId" INTEGER,
DROP COLUMN "material",
ADD COLUMN     "material" TEXT,
ALTER COLUMN "colorHex" DROP NOT NULL,
ALTER COLUMN "tip" SET DEFAULT '';

-- Legacy rows were uploaded files, and the file columns are gone above:
-- there is no link to hand Bambuddy. An empty string marks "no link" — the
-- story page renders it as such, and requeue refuses it.
UPDATE "story" SET "modelUrl" = '' WHERE "modelUrl" IS NULL;
ALTER TABLE "story" ALTER COLUMN "modelUrl" SET NOT NULL;

-- AlterEnum
-- `Accepted` and `Delivery` no longer exist. A legacy ticket that already
-- reached Delivery was printed, so it is Done. Every other open legacy
-- ticket (Requested, Accepted, Printing) has neither a link nor a Bambuddy
-- chain, so the new flow can't advance it — intake would retry an empty
-- link forever, and sync would leave Printing untouched. Close those as
-- Failed with a reason the requester can see.
BEGIN;
CREATE TYPE "StoryStatus_new" AS ENUM ('Requested', 'Slicing', 'Ready', 'Printing', 'Done', 'Failed', 'Declined');
ALTER TABLE "public"."story" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "story"
SET "errorMessage" = 'This request was made before link-based intake and can''t be sliced automatically — please submit it again as a link.'
WHERE "status"::text IN ('Requested', 'Accepted', 'Printing');
ALTER TABLE "story" ALTER COLUMN "status" TYPE "StoryStatus_new" USING (
  CASE "status"::text
    WHEN 'Delivery' THEN 'Done'
    WHEN 'Requested' THEN 'Failed'
    WHEN 'Accepted' THEN 'Failed'
    WHEN 'Printing' THEN 'Failed'
    ELSE "status"::text
  END
)::"StoryStatus_new";
ALTER TYPE "StoryStatus" RENAME TO "StoryStatus_old";
ALTER TYPE "StoryStatus_new" RENAME TO "StoryStatus";
DROP TYPE "public"."StoryStatus_old";
ALTER TABLE "story" ALTER COLUMN "status" SET DEFAULT 'Requested';
COMMIT;

-- DropEnum
DROP TYPE "Material";

-- CreateIndex
CREATE INDEX "story_queueItemId_idx" ON "story"("queueItemId");

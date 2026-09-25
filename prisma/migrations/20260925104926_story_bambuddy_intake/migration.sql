-- AlterEnum
BEGIN;
CREATE TYPE "StoryStatus_new" AS ENUM ('Requested', 'Slicing', 'Ready', 'Printing', 'Done', 'Failed', 'Declined');
ALTER TABLE "public"."story" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "story" ALTER COLUMN "status" TYPE "StoryStatus_new" USING ("status"::text::"StoryStatus_new");
ALTER TYPE "StoryStatus" RENAME TO "StoryStatus_old";
ALTER TYPE "StoryStatus_new" RENAME TO "StoryStatus";
DROP TYPE "public"."StoryStatus_old";
ALTER TABLE "story" ALTER COLUMN "status" SET DEFAULT 'Requested';
COMMIT;

-- AlterTable
ALTER TABLE "story" DROP COLUMN "dims",
DROP COLUMN "fileSize",
DROP COLUMN "filename",
DROP COLUMN "mimeType",
DROP COLUMN "printSettings",
DROP COLUMN "storageKey",
ADD COLUMN     "archiveId" INTEGER,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "libraryFileId" INTEGER,
ADD COLUMN     "modelUrl" TEXT NOT NULL,
ADD COLUMN     "neededBy" TIMESTAMP(3),
ADD COLUMN     "pipelineRunId" INTEGER,
ADD COLUMN     "plateCount" INTEGER,
ADD COLUMN     "queueItemId" INTEGER,
ADD COLUMN     "resolvedTitle" TEXT,
ADD COLUMN     "slicedLibraryFileId" INTEGER,
ADD COLUMN     "spoolId" INTEGER,
DROP COLUMN "material",
ADD COLUMN     "material" TEXT,
ALTER COLUMN "colorHex" DROP NOT NULL,
ALTER COLUMN "tip" SET DEFAULT '';

-- DropEnum
DROP TYPE "Material";

-- CreateIndex
CREATE INDEX "story_queueItemId_idx" ON "story"("queueItemId");


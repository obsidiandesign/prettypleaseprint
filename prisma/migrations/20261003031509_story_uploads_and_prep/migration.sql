-- AlterEnum
ALTER TYPE "StoryStatus" ADD VALUE 'Prep';

-- AlterTable
ALTER TABLE "story" ADD COLUMN     "libraryFileKind" TEXT,
ADD COLUMN     "preparedFilename" TEXT,
ADD COLUMN     "sourceFilename" TEXT;

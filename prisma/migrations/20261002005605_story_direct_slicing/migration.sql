-- AlterTable
ALTER TABLE "story" ADD COLUMN     "filamentGrams" DOUBLE PRECISION,
ADD COLUMN     "printPlates" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "printSeconds" INTEGER,
ADD COLUMN     "queueBatchId" INTEGER,
ADD COLUMN     "queueItemIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "sliceJobId" INTEGER;

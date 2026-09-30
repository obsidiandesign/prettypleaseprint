-- CreateTable
CREATE TABLE "storyFilament" (
    "id" SERIAL NOT NULL,
    "storyId" INTEGER NOT NULL,
    "slotId" INTEGER NOT NULL,
    "designColor" TEXT,
    "usedGrams" DOUBLE PRECISION NOT NULL,
    "spoolId" INTEGER,
    "material" TEXT,
    "colorName" TEXT,
    "colorHex" TEXT,

    CONSTRAINT "storyFilament_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storyFilament_storyId_slotId_key" ON "storyFilament"("storyId", "slotId");

-- AddForeignKey
ALTER TABLE "storyFilament" ADD CONSTRAINT "storyFilament_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

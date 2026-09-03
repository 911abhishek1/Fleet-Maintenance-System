-- Pre-migration data safety: convert any existing OVERDUE records to DUE
UPDATE "ServiceRecord" SET "status" = 'DUE' WHERE "status"::text = 'OVERDUE';

-- AlterEnum: Remove OVERDUE from ServiceStatus enum
BEGIN;
CREATE TYPE "ServiceStatus_new" AS ENUM ('DUE', 'BOOKED', 'IN_SERVICE', 'COMPLETED');
ALTER TABLE "public"."ServiceRecord" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ServiceRecord" ALTER COLUMN "status" TYPE "ServiceStatus_new" USING ("status"::text::"ServiceStatus_new");
ALTER TYPE "ServiceStatus" RENAME TO "ServiceStatus_old";
ALTER TYPE "ServiceStatus_new" RENAME TO "ServiceStatus";
DROP TYPE "public"."ServiceStatus_old";
ALTER TABLE "ServiceRecord" ALTER COLUMN "status" SET DEFAULT 'DUE';
COMMIT;

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_serviceRecordId_fkey";

-- AlterTable: AuditLog
ALTER TABLE "AuditLog" ADD COLUMN "action" TEXT NOT NULL DEFAULT 'UPDATE',
ADD COLUMN "vehicleId" TEXT,
ALTER COLUMN "serviceRecordId" DROP NOT NULL;

-- AlterTable: ServiceRecord
ALTER TABLE "ServiceRecord" ADD COLUMN "cycle" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "dueDate" TIMESTAMP(3);

-- AlterTable: Vehicle
ALTER TABLE "Vehicle" ADD COLUMN "dismissedAlertCycle" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastServiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lastServiceMileage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "serviceCycle" INTEGER NOT NULL DEFAULT 1;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_serviceRecordId_fkey" FOREIGN KEY ("serviceRecordId") REFERENCES "ServiceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Safe baseline and maintenance-cycle backfill:
-- 1. Initialize all vehicles to initial creation baseline (cycle 1)
UPDATE "Vehicle"
SET "lastServiceDate" = "createdAt",
    "lastServiceMileage" = "odometer",
    "serviceCycle" = 1,
    "dismissedAlertCycle" = 0;

-- 2. For vehicles with completed services:
-- Set lastServiceDate & lastServiceMileage from the most recent completed service
-- Set serviceCycle = (count of completed services) + 1 (the next active maintenance cycle)
WITH CompletedStats AS (
  SELECT
    "vehicleId",
    COUNT(*)::int AS completed_count,
    (ARRAY_AGG("dateCompleted" ORDER BY "dateCompleted" DESC, "createdAt" DESC))[1] AS latest_date,
    (ARRAY_AGG("completedOdometer" ORDER BY "dateCompleted" DESC, "createdAt" DESC))[1] AS latest_odometer
  FROM "ServiceRecord"
  WHERE "status"::text = 'COMPLETED' AND "dateCompleted" IS NOT NULL
  GROUP BY "vehicleId"
)
UPDATE "Vehicle" v
SET "lastServiceDate" = cs.latest_date,
    "lastServiceMileage" = COALESCE(cs.latest_odometer, v."odometer"),
    "serviceCycle" = cs.completed_count + 1
FROM CompletedStats cs
WHERE v."id" = cs."vehicleId";

-- 3. Backfill cycle numbers on completed ServiceRecords (1, 2, ... N per vehicle)
WITH RankedCompleted AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "vehicleId" ORDER BY "dateCompleted" ASC, "createdAt" ASC)::int AS cycle_num
  FROM "ServiceRecord"
  WHERE "status"::text = 'COMPLETED'
)
UPDATE "ServiceRecord" sr
SET "cycle" = rc.cycle_num
FROM RankedCompleted rc
WHERE sr."id" = rc."id";

-- 4. Backfill cycle numbers on active/uncompleted ServiceRecords to match the vehicle's current serviceCycle
UPDATE "ServiceRecord" sr
SET "cycle" = v."serviceCycle"
FROM "Vehicle" v
WHERE sr."vehicleId" = v."id"
  AND sr."status"::text != 'COMPLETED';


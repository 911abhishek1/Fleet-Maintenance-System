-- CreateIndex
CREATE INDEX "ServiceRecord_vehicleId_status_idx" ON "ServiceRecord"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "ServiceRecord_status_updatedAt_idx" ON "ServiceRecord"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ServiceRecord_dateScheduled_idx" ON "ServiceRecord"("dateScheduled");

-- CreateIndex
CREATE INDEX "TechnicianAssignment_userId_idx" ON "TechnicianAssignment"("userId");

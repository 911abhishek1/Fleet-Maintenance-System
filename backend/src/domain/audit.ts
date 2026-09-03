import { Prisma } from '@prisma/client';
import prisma from '../db';

export interface CreateAuditLogParams {
  vehicleId?: string | null;
  serviceRecordId?: string | null;
  changedById?: string | null;
  action: string;
  field: string;
  oldValue?: string | null;
  newValue?: string | null;
  notes?: string | null;
}

/**
 * Appends an immutable audit event to the AuditLog table.
 * Designed to participate in Prisma transactions or standalone operations.
 */
export async function logAuditEvent(
  client: Prisma.TransactionClient | typeof prisma,
  params: CreateAuditLogParams
) {
  return client.auditLog.create({
    data: {
      vehicleId: params.vehicleId ?? null,
      serviceRecordId: params.serviceRecordId ?? null,
      changedById: params.changedById ?? null,
      action: params.action,
      field: params.field,
      oldValue: params.oldValue ?? null,
      newValue: params.newValue ?? null,
      notes: params.notes ?? null,
    },
  });
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../auth.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requirePrimaryDesktopLoopback(request: FastifyRequest): void {
  // This queue is deliberately not a mobile/LAN API: only the Electron main
  // process on the primary Windows host may claim a physical print job.
  const ip = request.ip.replace(/^::ffff:/u, "");
  if (ip !== "127.0.0.1" && ip !== "::1") {
    throw new ApiError(403, "PRIMARY_DESKTOP_REQUIRED", "أوامر طباعة الاستلام متاحة لجهاز نبتة الرئيسي فقط");
  }
}

/**
 * This small pull queue keeps phone printing out of the public mobile API.
 * Only the authenticated Windows terminal claims work, then confirms a print
 * result.  A job is never silently re-queued after it has been claimed: this
 * deliberately favours avoiding a duplicate physical receipt.
 */
export function registerMobilePrintJobRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/mobile-print-jobs/next", async (request) => {
    requirePrimaryDesktopLoopback(request);
    const auth = requireAuth(request);
    return transaction(db, async (client) => {
      const candidate = await client.query<{ kind: "PURCHASE" | "SALE" | "WEIGHTED_LABEL"; id: string }>(`
        SELECT kind, id FROM (
          SELECT 'PURCHASE'::text AS kind, j.id, j.requested_at
          FROM mobile_purchase_receipt_print_jobs j
          JOIN purchase_receipts pr ON pr.id = j.receipt_id
          JOIN terminals t ON t.id = $1
          WHERE j.state = 'QUEUED' AND pr.warehouse_id = t.warehouse_id
          UNION ALL
          SELECT 'SALE'::text AS kind, j.id, j.requested_at
          FROM mobile_sale_receipt_print_jobs j
          JOIN sales s ON s.id = j.sale_id
          JOIN terminals t ON t.id = $1
          WHERE j.state = 'QUEUED' AND s.warehouse_id = t.warehouse_id
          UNION ALL
          SELECT 'WEIGHTED_LABEL'::text AS kind, j.id, j.requested_at
          FROM mobile_weighted_label_print_jobs j
          JOIN weighted_product_labels l ON l.barcode = j.barcode
          JOIN stock_balances sb ON sb.product_id = l.product_id
          JOIN terminals t ON t.id = $1
          WHERE j.state = 'QUEUED' AND sb.warehouse_id = t.warehouse_id
        ) candidates
        ORDER BY requested_at, id
        LIMIT 1
      `, [auth.terminalId]);
      const selected = candidate.rows[0];
      if (!selected) return { job: null };
      const next = selected.kind === "PURCHASE"
        ? await client.query<{ id: string; document_id: string }>(`
            SELECT j.id, j.receipt_id AS document_id
            FROM mobile_purchase_receipt_print_jobs j
            JOIN purchase_receipts pr ON pr.id = j.receipt_id
            JOIN terminals t ON t.id = $2
            WHERE j.id = $1 AND j.state = 'QUEUED' AND pr.warehouse_id = t.warehouse_id
            FOR UPDATE OF j SKIP LOCKED
          `, [selected.id, auth.terminalId])
        : selected.kind === "SALE" ? await client.query<{ id: string; document_id: string }>(`
            SELECT j.id, j.sale_id AS document_id
            FROM mobile_sale_receipt_print_jobs j
            JOIN sales s ON s.id = j.sale_id
            JOIN terminals t ON t.id = $2
            WHERE j.id = $1 AND j.state = 'QUEUED' AND s.warehouse_id = t.warehouse_id
            FOR UPDATE OF j SKIP LOCKED
          `, [selected.id, auth.terminalId])
        : await client.query<{ id: string; document_id: string }>(`
            SELECT j.id, j.barcode AS document_id
            FROM mobile_weighted_label_print_jobs j
            JOIN weighted_product_labels l ON l.barcode = j.barcode
            JOIN stock_balances sb ON sb.product_id = l.product_id
            JOIN terminals t ON t.id = $2
            WHERE j.id = $1 AND j.state = 'QUEUED' AND sb.warehouse_id = t.warehouse_id
            FOR UPDATE OF j SKIP LOCKED
          `, [selected.id, auth.terminalId]);
      const job = next.rows[0];
      if (!job) return { job: null };
      const table = selected.kind === "PURCHASE" ? "mobile_purchase_receipt_print_jobs" : selected.kind === "SALE" ? "mobile_sale_receipt_print_jobs" : "mobile_weighted_label_print_jobs";
      await client.query(`
        UPDATE ${table}
        SET state = 'CLAIMED', claimed_by_terminal_id = $2, claimed_at = now()
        WHERE id = $1
      `, [job.id, auth.terminalId]);
      return { job: { id: job.id, kind: selected.kind, documentId: job.document_id } };
    });
  });

  app.post("/v1/mobile-print-jobs/:jobId/complete", async (request) => {
    requirePrimaryDesktopLoopback(request);
    const auth = requireAuth(request);
    const { jobId } = request.params as { jobId?: string };
    if (!jobId || !uuidPattern.test(jobId)) throw new ApiError(400, "PRINT_JOB_ID_INVALID", "معرّف أمر الطباعة غير صحيح");
    const input = (request.body ?? {}) as { printed?: unknown; errorCode?: unknown; errorMessage?: unknown };
    if (typeof input.printed !== "boolean") throw new ApiError(400, "PRINT_RESULT_REQUIRED", "حدّد نتيجة الطباعة");
    const errorCode = typeof input.errorCode === "string" ? input.errorCode.trim().slice(0, 80) : null;
    const errorMessage = typeof input.errorMessage === "string" ? input.errorMessage.trim().slice(0, 500) : null;
    let updated = await db.query<{ id: string }>(`
      UPDATE mobile_purchase_receipt_print_jobs
      SET state = $3,
          completed_at = now(),
          error_code = CASE WHEN $3 = 'FAILED' THEN $4 ELSE NULL END,
          error_message = CASE WHEN $3 = 'FAILED' THEN $5 ELSE NULL END
      WHERE id = $1 AND state = 'CLAIMED' AND claimed_by_terminal_id = $2
      RETURNING id
    `, [jobId, auth.terminalId, input.printed ? "PRINTED" : "FAILED", errorCode, errorMessage]);
    if (!updated.rows[0]) {
      updated = await db.query<{ id: string }>(`
        UPDATE mobile_sale_receipt_print_jobs
        SET state = $3,
            completed_at = now(),
            error_code = CASE WHEN $3 = 'FAILED' THEN $4 ELSE NULL END,
            error_message = CASE WHEN $3 = 'FAILED' THEN $5 ELSE NULL END
        WHERE id = $1 AND state = 'CLAIMED' AND claimed_by_terminal_id = $2
        RETURNING id
      `, [jobId, auth.terminalId, input.printed ? "PRINTED" : "FAILED", errorCode, errorMessage]);
    }
    if (!updated.rows[0]) {
      updated = await db.query<{ id: string }>(`
        UPDATE mobile_weighted_label_print_jobs
        SET state = $3,
            completed_at = now(),
            error_code = CASE WHEN $3 = 'FAILED' THEN $4 ELSE NULL END,
            error_message = CASE WHEN $3 = 'FAILED' THEN $5 ELSE NULL END
        WHERE id = $1 AND state = 'CLAIMED' AND claimed_by_terminal_id = $2
        RETURNING id
      `, [jobId, auth.terminalId, input.printed ? "PRINTED" : "FAILED", errorCode, errorMessage]);
    }
    if (!updated.rows[0]) throw new ApiError(409, "PRINT_JOB_NOT_CLAIMED", "أمر الطباعة غير متاح لهذا الجهاز أو تمت معالجته بالفعل");
    return { completed: true };
  });
}

import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { ApiError, errorHandler } from "./errors.js";
import { installAuth } from "./auth.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerShiftRoutes } from "./routes/shifts.js";
import { registerSaleRoutes } from "./routes/sales.js";
import { registerReturnRoutes } from "./routes/returns.js";
import { registerPurchaseRoutes } from "./routes/purchases.js";
import { registerStockRoutes } from "./routes/stock.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerBackupRoutes } from "./routes/backups.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerPartnerRoutes } from "./routes/partners.js";
import { registerInvoiceRoutes } from "./routes/invoices.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerWeightedLabelRoutes } from "./routes/weighted-labels.js";
import { registerCommerceRoutes } from "./routes/commerce.js";
import { registerTerminalEnrollmentRoutes } from "./routes/terminals.js";
import { registerCloudMigrationRoutes } from "./routes/cloud-migration.js";
import { registerPayrollRoutes } from "./routes/payroll.js";
import { registerMobilePrintJobRoutes } from "./routes/mobile-print-jobs.js";

export function buildApp(config: AppConfig, db: Database, options: { logger?: boolean; https?: { key?: Buffer; cert?: Buffer; pfx?: Buffer; passphrase?: string } } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.x-nabta-commerce-key", "req.headers.x-nabta-terminal-relay-key", "req.body.password", "req.body.managerPassword", "req.body.setupToken", "req.body.confirmationCode"] },
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    trustProxy: false,
    ...(options.https ? { https: options.https } : {}),
  });
  app.setErrorHandler(errorHandler);
  app.addHook("onRequest", async (request) => {
    if (!config.TERMINAL_RELAY_SHARED_SECRET) return;
    const host = request.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return;
    const terminalKey = request.headers["x-nabta-terminal-relay-key"];
    const commerceKey = request.headers["x-nabta-commerce-key"];
    if (terminalKey === config.TERMINAL_RELAY_SHARED_SECRET || commerceKey === config.COMMERCE_API_SHARED_SECRET) return;
    throw new ApiError(403, "REMOTE_RELAY_REQUIRED", "اتصال الأجهزة البعيدة يجب أن يمر عبر Cloudflare Relay الموثوق");
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  });
  installAuth(app, db);
  app.get("/v1/health", async () => {
    const database = await db.query<{ now: Date }>("SELECT now()");
    const setup = await db.query<{ setup_completed: boolean }>("SELECT setup_completed FROM system_state WHERE singleton");
    return { status: "ok", databaseTime: database.rows[0]!.now.toISOString(), setupCompleted: setup.rows[0]?.setup_completed ?? false, version: "0.1.0" };
  });
  registerSetupRoutes(app, db, config);
  registerTerminalEnrollmentRoutes(app, db, config);
  registerAuthRoutes(app, db, config);
  registerCatalogRoutes(app, db);
  registerWeightedLabelRoutes(app, db);
  registerShiftRoutes(app, db);
  registerSaleRoutes(app, db);
  registerReturnRoutes(app, db);
  registerPurchaseRoutes(app, db);
  registerStockRoutes(app, db);
  registerReportRoutes(app, db);
  registerPayrollRoutes(app, db);
  registerBackupRoutes(app, db, config);
  registerCloudMigrationRoutes(app, db, config);
  registerAdminRoutes(app, db, config);
  registerPartnerRoutes(app, db);
  registerInvoiceRoutes(app, db);
  registerMobilePrintJobRoutes(app, db);
  registerPaymentRoutes(app, db, config);
  registerCommerceRoutes(app, db, config);
  return app;
}

import type { DbClient } from "./db.js";

export type Role = "OWNER" | "MANAGER" | "CASHIER" | "STOCK_KEEPER";

export interface AuthContext {
  sessionId: string;
  userId: string;
  terminalId: string;
  displayName: string;
  role: Role;
  discountLimitBps: number;
  permissions: Set<string>;
}

export interface TransactionContext {
  client: DbClient;
  auth: AuthContext;
  requestId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

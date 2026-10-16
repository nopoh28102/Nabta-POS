import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));

export type DbRow = QueryResultRow;
export interface DbResult<T extends DbRow = DbRow> {
  rows: T[];
  rowCount: number;
  command?: string;
}
export interface DbClient {
  query<T extends DbRow = DbRow>(sql: string, values?: unknown[]): Promise<DbResult<T>>;
}
export interface Database extends DbClient {
  readonly kind: "postgres" | "embedded";
  exec(sql: string): Promise<void>;
  end(): Promise<void>;
  dumpDataDir?(): Promise<Uint8Array>;
}

function result<T extends DbRow>(value: { rows: T[]; rowCount?: number; affectedRows?: number; command?: string }): DbResult<T> {
  const output: DbResult<T> = { rows: value.rows, rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length };
  if (value.command !== undefined) output.command = value.command;
  return output;
}

class PostgresDatabase implements Database {
  readonly kind = "postgres" as const;
  constructor(private readonly pool: InstanceType<typeof Pool>) {}
  async query<T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<DbResult<T>> {
    const output = await this.pool.query<T>(sql, values);
    return { rows: output.rows, rowCount: output.rowCount ?? output.rows.length, command: output.command };
  }
  async exec(sql: string): Promise<void> { await this.pool.query(sql); }
  async end(): Promise<void> { await this.pool.end(); }
  async connect(): Promise<PoolClient> { return this.pool.connect(); }
}

class EmbeddedClient implements DbClient {
  constructor(private readonly client: PGlite | Transaction) {}
  async query<T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<DbResult<T>> {
    const output = await this.client.query<T>(sql, values);
    return result(output);
  }
}

class EmbeddedDatabase implements Database {
  readonly kind = "embedded" as const;
  constructor(private readonly pglite: PGlite) {}
  async query<T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<DbResult<T>> {
    return new EmbeddedClient(this.pglite).query<T>(sql, values);
  }
  async exec(sql: string): Promise<void> { await this.pglite.exec(sql); }
  async end(): Promise<void> { await this.pglite.close(); }
  async withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    return this.pglite.transaction(async (tx) => fn(new EmbeddedClient(tx)));
  }
  async dumpDataDir(): Promise<Uint8Array> {
    const dump = await this.pglite.dumpDataDir();
    return dump instanceof Uint8Array ? dump : new Uint8Array(await dump.arrayBuffer());
  }
}

export function createDatabase(connectionString: string): Database {
  return new PostgresDatabase(new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: "nabta-server" }));
}

export async function createEmbeddedDatabase(dataDir: string): Promise<Database> {
  const db = new PGlite(dataDir, { extensions: { pgcrypto } });
  await db.waitReady;
  return new EmbeddedDatabase(db);
}

export async function createConfiguredDatabase(config: { DATABASE_MODE: "embedded" | "postgres"; DATABASE_DIR: string; DATABASE_URL?: string | undefined }): Promise<Database> {
  if (config.DATABASE_MODE === "postgres") {
    if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required when DATABASE_MODE=postgres");
    return createDatabase(config.DATABASE_URL);
  }
  return createEmbeddedDatabase(config.DATABASE_DIR);
}

export async function transaction<T>(db: Database, fn: (client: DbClient) => Promise<T>): Promise<T> {
  if (db.kind === "embedded") return (db as EmbeddedDatabase).withTransaction(fn);
  const client = await (db as PostgresDatabase).connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends QueryResultRow>(client: DbClient, sql: string, values: unknown[] = []): Promise<T> {
  const output = await client.query<T>(sql, values);
  if (output.rowCount !== 1) throw new Error(`expected one row, received ${output.rowCount}`);
  return output.rows[0]!;
}

export async function maybeOne<T extends QueryResultRow>(client: DbClient, sql: string, values: unknown[] = []): Promise<T | null> {
  const output = await client.query<T>(sql, values);
  if (output.rowCount > 1) throw new Error(`expected zero or one row, received ${output.rowCount}`);
  return output.rows[0] ?? null;
}

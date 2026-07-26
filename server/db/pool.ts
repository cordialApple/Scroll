import { Pool } from 'pg'

export const DEFAULT_LOCAL_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/scroll'

export function createPool(databaseUrl?: string): Pool {
  return new Pool({ connectionString: databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL })
}

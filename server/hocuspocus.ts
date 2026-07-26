import { Hocuspocus } from '@hocuspocus/server'
import { createPool } from './db/pool'
import { bootstrapSchema, createPostgresStore } from './db/store'
import { createPersistenceExtension } from './db/persistenceExtension'

export interface ScrollServerOptions {
  port: number
  quiet?: boolean
  databaseUrl?: string
}

// P3.4: persist-before-broadcast durable store. Ingress hook appends every update to Postgres before
// MessageReceiver applies/broadcasts it (see db/persistenceExtension.ts); single-authority epoch
// fencing on top of this store is P3.5.
export async function createScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const pool = createPool(opts.databaseUrl)
  await bootstrapSchema(pool)

  return new Hocuspocus({
    port: opts.port,
    quiet: opts.quiet ?? true,
    extensions: [
      createPersistenceExtension(createPostgresStore(pool)),
      { async onDestroy() { await pool.end() } },
    ],
  })
}

export async function startScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const server = await createScrollServer(opts)
  await server.listen()
  return server
}

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
// MessageReceiver applies/broadcasts it (see db/persistenceExtension.ts). P3.5: the compaction
// transaction is owner_epoch-fenced at the store (latent at single-owner localhost).
export async function createScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const pool = createPool(opts.databaseUrl)
  await bootstrapSchema(pool)

  return new Hocuspocus({
    port: opts.port,
    quiet: opts.quiet ?? true,
    extensions: [
      createPersistenceExtension(createPostgresStore(pool)),
      // Hocuspocus registers its own process-wide SIGINT/SIGTERM/SIGQUIT handler on every listen()
      // call and never removes it (even after destroy()) — in a test run that creates many servers,
      // one real termination signal fires all of them, each re-destroying its own already-destroyed
      // server. Guard so a second onDestroy for the same pool is a no-op instead of pg-pool's "Called
      // end on pool more than once" throw.
      { async onDestroy() { if (!pool.ended) await pool.end() } },
    ],
  })
}

export async function startScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const server = await createScrollServer(opts)
  await server.listen()
  return server
}

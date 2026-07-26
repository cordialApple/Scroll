import { Hocuspocus } from '@hocuspocus/server'

export interface ScrollServerOptions {
  port: number
  quiet?: boolean
}

// Minimal P3.1 relay: in-memory docs, Hocuspocus-handled awareness, NO durable store. Persist-before-
// broadcast + Postgres is P3.4; single-authority fencing is P3.5. This stage only proves real transport.
export function createScrollServer(opts: ScrollServerOptions): Hocuspocus {
  return new Hocuspocus({ port: opts.port, quiet: opts.quiet ?? true })
}

export async function startScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const server = createScrollServer(opts)
  await server.listen()
  return server
}

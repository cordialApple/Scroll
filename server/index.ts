import { startScrollServer } from './hocuspocus'

const port = Number(process.env.SCROLL_WS_PORT ?? 1234)

startScrollServer({ port, quiet: false }).then(() => {
  console.error(`[scroll] hocuspocus relay listening on ws://127.0.0.1:${port}`)
})

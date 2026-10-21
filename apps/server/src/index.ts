import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8790);
const server = serve({ fetch: createApp().fetch, hostname: "127.0.0.1", port }, () => {
  console.info(`H3 Motion API: http://127.0.0.1:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

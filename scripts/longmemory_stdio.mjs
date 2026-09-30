/** Installed beside dist; keep shared project access and close the runtime on stdin EOF. */
import { create_stdio_mcp } from "./dist/mcp/transports/stdio.js";

const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error("LongMemory database path is required.");
const memory = create_stdio_mcp({
    db_path: dbPath,
    tenant_id: "default",
    user_id: "default",
    project_id: null,
    env: process.env,
});
const disconnected = new Promise(resolve => {
    process.stdin.once("end", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
});
await memory.start();
await disconnected;
await memory.close();

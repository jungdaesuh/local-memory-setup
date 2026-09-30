import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [bootstrap, dbPath, toolList] = process.argv.slice(2);
if (bootstrap === undefined || dbPath === undefined || toolList === undefined) throw new Error("Expected the LongMemory stdio bootstrap, a temporary database path, and required tool names.");
const expectedTools = JSON.parse(toolList);
if (!Array.isArray(expectedTools) || !expectedTools.every((name) => typeof name === "string")) throw new Error("Required LongMemory tools must be a JSON array of names.");

process.umask(0o077);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:LONGMEMORY_|OM_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
env.LONGMEMORY_DB_PATH = dbPath;
env.LONGMEMORY_MCP_HTTP = "false";
env.LONGMEMORY_TENANT_ID = "default";

const closedProbe = spawnSync(process.execPath, [bootstrap, dbPath], {
    cwd: process.cwd(),
    env,
    input: "",
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
});
if (closedProbe.error) throw new Error(`LongMemory stdio bootstrap could not close on stdin EOF: ${closedProbe.error.message}`);
if (closedProbe.status !== 0 || closedProbe.stderr.includes("unsettled top-level await")) {
    throw new Error(`LongMemory stdio bootstrap did not exit cleanly on stdin EOF (status ${closedProbe.status}): ${closedProbe.stderr.trim() || closedProbe.stdout.trim()}.`);
}

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bootstrap, dbPath],
    env,
    stderr: "pipe",
});
const client = new Client({ name: "local-memory-setup-smoke", version: "1.0.0" });
const verifyClientClosed = observeClientClose(client, transport);
let timeout;
try {
    const check = async () => {
        await client.connect(transport);
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((tool) => tool.name));
        const missing = expectedTools.filter((name) => !names.has(name));
        if (missing.length > 0) throw new Error(`LongMemory stdio tools/list omitted: ${missing.join(", ")}.`);

        const decision = `LongMemory native stdio persistence smoke ${process.pid}`;
        const stored = await client.callTool({
            name: "longmemory_remember_decision",
            arguments: {
                project_id: "security-smoke",
                decision,
                reason: "Verify durable project-scoped memory through the pinned native stdio transport.",
            },
        });
        if (stored.isError || stored.structuredContent?.project_id !== "security-smoke" || typeof stored.structuredContent?.memory_id !== "string") {
            throw new Error(`LongMemory stdio could not persist a decision for security-smoke: ${stored.content.find((item) => item.type === "text")?.text ?? "no tool response"}.`);
        }
    };
    await Promise.race([
        check(),
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("LongMemory stdio MCP did not answer within 30 seconds.")), 30_000);
        }),
    ]);
} finally {
    clearTimeout(timeout);
    await client.close();
}
verifyClientClosed();

const recallTransport = new StdioClientTransport({
    command: process.execPath,
    args: [bootstrap, dbPath],
    env,
    stderr: "pipe",
});
const recallClient = new Client({ name: "local-memory-setup-smoke-recall", version: "1.0.0" });
const verifyRecallClientClosed = observeClientClose(recallClient, recallTransport);
try {
    await recallClient.connect(recallTransport);
    const decision = `LongMemory native stdio persistence smoke ${process.pid}`;
    const recalled = await recallClient.callTool({
        name: "longmemory_recall",
        arguments: { project_id: "security-smoke", query: decision, mode: "strict", token_budget: 2048 },
    });
    const responseText = recalled.content.find((item) => item.type === "text")?.text ?? "";
    if (recalled.isError || !responseText.includes(decision)) {
        throw new Error(`LongMemory stdio could not recall the persisted security-smoke decision: ${responseText || "no tool response"}.`);
    }
} finally {
    await recallClient.close();
}
verifyRecallClientClosed();
process.stdout.write("LongMemory native stdio smoke passed: tools/list, remember_decision, and cross-process recall for security-smoke.\n");

/** @param {Client} client @param {StdioClientTransport} transport */
function observeClientClose(client, transport) {
    const stderr = transport.stderr;
    if (stderr === null) throw new Error("LongMemory stdio smoke could not observe bootstrap stderr.");
    let output = "";
    let closed = false;
    stderr.on("data", (chunk) => { output += chunk.toString(); });
    client.onclose = () => { closed = true; };
    return () => {
        if (!closed) throw new Error("LongMemory stdio smoke transport closed before its child process exited.");
        if (output.includes("unsettled top-level await")) throw new Error(`LongMemory stdio bootstrap did not close its runtime cleanly: ${output.trim()}.`);
    };
}

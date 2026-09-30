/**
 * LongMemory's settings file (~/.config/local-memory-setup/longmemory.env), read by
 * the server through `node --env-file`. Only variables LongMemory 9ee2c8e1 reads for
 * `serve` are written: src/server/config.ts (host, port, key, MCP HTTP, database) and
 * src/core/embeddings/environment.ts (provider, tier, dimension, Ollama URL and model).
 * Project and user ids are not written: `serve` hardcodes tenant and user "default"
 * (src/cli/context/cli_context.ts memory_config).
 */
import { LONGMEMORY_PORT, MARKER, OLLAMA_ORIGIN } from "./layout.mjs";

/**
 * @param {{ dbPath: string, model: string, dimension: number }} spec
 * @returns {[string, string][]}
 */
export function longMemorySettings(spec) {
    return [
        ["LONGMEMORY_HOST", "127.0.0.1"],
        ["LONGMEMORY_PORT", String(LONGMEMORY_PORT)],
        ["LONGMEMORY_MCP_HTTP", "true"],
        ["LONGMEMORY_DB_PATH", spec.dbPath],
        ["LONGMEMORY_EMBEDDING_PROVIDER", "ollama"],
        ["LONGMEMORY_EMBEDDING_TIER", "deep"],
        ["LONGMEMORY_EMBEDDING_DIMENSION", String(spec.dimension)],
        ["LONGMEMORY_OLLAMA_URL", OLLAMA_ORIGIN],
        ["LONGMEMORY_OLLAMA_EMBEDDING_MODEL", spec.model],
    ];
}

/**
 * Every variable the file sets, plus LongMemory's key variables (src/server/config.ts:
 * LONGMEMORY_API_KEY, alias OM_API_KEY). The runner unsets all of them before
 * `node --env-file`, because Node lets an inherited environment variable override the
 * file's value, and the server must run keyless: it listens on 127.0.0.1 only, and with
 * no key set its auth middleware lets local calls through (middleware/auth.ts).
 */
export const LONGMEMORY_ENV_KEYS = [...longMemorySettings({ dbPath: "", model: "", dimension: 0 }).map(([key]) => key), "LONGMEMORY_API_KEY", "OM_API_KEY"];

/** @param {readonly [string, string][]} settings */
export function renderEnvFile(settings) {
    for (const [key, value] of settings) if (/[\r\n]/.test(value)) throw new Error(`${key} cannot hold a line break.`);
    const header = [
        `# ${MARKER}. Read by LongMemory through node --env-file.`,
        "# LongMemory falls back to a synthetic embedder when Ollama fails (src/core/embeddings/stack.ts);",
        "# the service runner waits until Ollama lists the model before starting LongMemory.",
    ];
    return `${[...header, ...settings.map(([key, value]) => `${key}=${value}`)].join("\n")}\n`;
}

/** @param {string} text @returns {Record<string, string>} */
export function parseEnvFile(text) {
    return Object.fromEntries(
        text
            .split(/\r?\n/)
            .filter((line) => line && !line.startsWith("#") && line.indexOf("=") > 0)
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
}

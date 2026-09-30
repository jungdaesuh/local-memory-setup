/** Retire a registered setup-owned task using Task Scheduler's authoritative XML. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory } from "./private_storage.mjs";
import { run } from "./proc.mjs";
import { MANAGED_MARKER } from "./service_files.mjs";
import { SERVICE_NAMES } from "./layout.mjs";

/** @param {ReturnType<import("./layout.mjs").layout>} L @param {"qmd" | "longmemory"} service @param {typeof run} [runner] */
export function retireWindowsMemoryTask(L, service, runner = run) {
    const name = SERVICE_NAMES[service].task;
    const registered = runner("schtasks", ["/Query", "/TN", name], { allowFail: true, timeoutMs: 15_000 });
    if (registered.status !== 0) return;
    // The native CLI's XML output uses the console codepage; request Unicode
    // XML from the scheduler API and explicitly match run()'s UTF-8 decoder.
    const script = [
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
        `$xml = Export-ScheduledTask -TaskName '${name}' -TaskPath '\\' -ErrorAction Stop`,
        "[Console]::Write($xml)",
    ].join("; ");
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    const exported = runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], { timeoutMs: 15_000 });
    const xml = exported.stdout;
    if (!xml.includes(MANAGED_MARKER)) throw new Error(`Foreign registered task ${name} was left unchanged.`);
    const bytes = /encoding=["']UTF-16["']/i.test(xml) ? Buffer.from(`\ufeff${xml.replace(/^\ufeff/, "")}`, "utf16le") : Buffer.from(xml, "utf8");
    const dir = path.join(L.configDir, "backups");
    ensurePrivateDirectory(dir);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const backup = path.join(dir, `${name}-${hash}.xml`);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, bytes, { mode: 0o600, flag: "wx" });
    runner("schtasks", ["/End", "/TN", name], { allowFail: true });
    runner("schtasks", ["/Delete", "/TN", name, "/F"]);
}

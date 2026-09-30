import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { layout } from "./layout.mjs";
import { MANAGED_MARKER } from "./service_files.mjs";
import { retireWindowsMemoryTask } from "./task_retirement.mjs";

test("registered owned tasks retire and back up even when original XML is missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lms-task-retire-"));
    const L = layout(process.platform, home, {});
    const xml = `<?xml version="1.0" encoding="UTF-16"?><Task><RegistrationInfo><Description>${MANAGED_MARKER}</Description></RegistrationInfo></Task>`;
    const calls = [];
    const runner = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: command === "powershell.exe" ? xml : "", stderr: "" }; };
    retireWindowsMemoryTask(L, "longmemory", runner);
    assert.deepEqual(calls.map(call => call[0]), ["schtasks", "powershell.exe", "schtasks", "schtasks"]);
    assert.deepEqual(calls.filter(call => call[0] === "schtasks").map(call => call[1]), ["/Query", "/End", "/Delete"]);
    const dir = path.join(L.configDir, "backups");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, files[0]), "utf16le"), `\ufeff${xml}`);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
    fs.rmSync(home, { recursive: true });
});

test("foreign registered tasks stay unchanged and absent tasks need no input XML", () => {
    const L = layout("linux", "/unused-home", {});
    const calls = [];
    const foreign = (command, args) => { calls.push(args); return { status: 0, stdout: "<Task>foreign</Task>", stderr: "" }; };
    assert.throws(() => retireWindowsMemoryTask(L, "qmd", foreign), /Foreign registered task/);
    assert.equal(calls.length, 2);
    retireWindowsMemoryTask(L, "qmd", () => ({ status: 1, stdout: "", stderr: "missing" }));
});

test("registered task backup preserves non-ASCII paths through the UTF-8 process-output seam", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lms-task-unicode-"));
    const L = layout(process.platform, home, {});
    const prefix = `<?xml version="1.0" encoding="UTF-16"?><Task><Description>${MANAGED_MARKER}</Description><Command>C:\\Users\\`;
    const suffix = "\\runner.cmd</Command></Task>";
    const xml = `${prefix}日本${suffix}`;
    const legacyBytes = Buffer.concat([Buffer.from(prefix), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from(suffix)]);
    const runner = (command, args) => {
        if (command === "powershell.exe") {
            const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
            assert.match(script, /Console\]::OutputEncoding\s*=\s*\[Text.UTF8Encoding\]::new\(\$false\)/);
            assert.match(script, /Export-ScheduledTask/);
            const result = spawnSync(process.execPath, ["-e", 'process.stdout.write(Buffer.from(process.argv[1], "base64"))', Buffer.from(xml).toString("base64")], { encoding: "utf8" });
            return { status: result.status, stdout: result.stdout, stderr: result.stderr };
        }
        return { status: 0, stdout: args.includes("/XML") ? legacyBytes.toString("utf8") : "", stderr: "" };
    };
    try {
        retireWindowsMemoryTask(L, "qmd", runner);
        const dir = path.join(L.configDir, "backups");
        const [backup] = fs.readdirSync(dir);
        assert.equal(fs.readFileSync(path.join(dir, backup), "utf16le"), `\ufeff${xml}`);
    } finally {
        fs.rmSync(home, { recursive: true });
    }
});

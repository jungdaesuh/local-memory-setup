import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { qmdEnvironment } from "./qmd_env.mjs";
import { MANAGED_MARKER, launchAgentPlist, managedPathBlockState, qmdDispatcher, runnerScript, shQuote, systemdUnit, windowsTaskExec, windowsTaskXml, withManagedPathBlock } from "./service_files.mjs";

test("shQuote survives single quotes and spaces", () => {
    const quoted = shQuote("/Users/o'neil/My Files");
    const echoed = spawnSync("/bin/sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
    assert.equal(echoed.stdout, "/Users/o'neil/My Files");
});

test("POSIX runner sets env, pins PATH, gates, then execs the quoted argv", () => {
    const text = runnerScript(
        {
            env: [["QMD_FORCE_CPU", "1"], ["QMD_LLAMA_GPU", null]],
            pathPrepend: "/opt/node 22/bin",
            gate: ["/n/node", "/s/wait.mjs", "http://127.0.0.1:11434/api/tags", "bge-m3", "120"],
            argv: ["/n/node", "/a b/cli.js", "serve"],
        },
        "linux",
    );
    assert.equal(
        text,
        [
            "#!/bin/sh",
            `# ${MANAGED_MARKER}`,
            "export QMD_FORCE_CPU='1'",
            "unset QMD_LLAMA_GPU",
            `export PATH='/opt/node 22/bin':"$PATH"`,
            "'/n/node' '/s/wait.mjs' 'http://127.0.0.1:11434/api/tags' 'bge-m3' '120' || exit 1",
            "exec '/n/node' '/a b/cli.js' 'serve'",
            "",
        ].join("\n"),
    );
});

test("Windows runner loops by itself, with PATH pinned once before the loop", () => {
    const text = runnerScript(
        { env: [["OLLAMA_HOST", "127.0.0.1:11434"], ["QMD_LLAMA_GPU", null]], pathPrepend: "C:\\node", gate: ["C:\\n\\node.exe", "C:\\s\\wait.mjs"], argv: ["C:\\o\\ollama.exe", "serve"] },
        "win32",
    );
    assert.equal(
        text,
        [
            "@echo off",
            `rem ${MANAGED_MARKER}`,
            "setlocal",
            'set "OLLAMA_HOST=127.0.0.1:11434"',
            'set "QMD_LLAMA_GPU="',
            'set "PATH=C:\\node;%PATH%"',
            ":run",
            '"C:\\n\\node.exe" "C:\\s\\wait.mjs" || goto pause',
            '"C:\\o\\ollama.exe" "serve"',
            ":pause",
            "ping -n 4 127.0.0.1 >nul",
            "goto run",
            "",
        ].join("\r\n"),
    );
    assert.throws(() => runnerScript({ env: [["X", "50%"]], pathPrepend: null, gate: null, argv: ["a"] }, "win32"), /batch file/);
    assert.throws(() => runnerScript({ env: [], pathPrepend: "C:\\a;b", gate: null, argv: ["a"] }, "win32"), /PATH/);
});

test("the POSIX qmd dispatcher gives embed the GPU, keeps everything else on the CPU, and runs QMD on the pinned Node", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-dispatch-"));
    const nodeDir = path.join(dir, "pinned-node");
    fs.mkdirSync(nodeDir);
    // The launcher re-spawns `node` from PATH; the dispatcher must make that the pinned one.
    fs.writeFileSync(path.join(nodeDir, "node"), "#!/bin/sh\necho pinned\n", { mode: 0o755 });
    const printer = path.join(dir, "print-env.sh");
    fs.writeFileSync(printer, 'printf "%s|%s|%s|%s|%s" "$1" "${QMD_FORCE_CPU-unset}" "${QMD_LLAMA_GPU-unset}" "${QMD_EMBED_MODEL-unset}" "$(node)"\n');
    const dispatcher = path.join(dir, "qmd");
    const hardware = { gpu: /** @type {const} */ ("nvidia") };
    fs.writeFileSync(
        dispatcher,
        qmdDispatcher({ node: "/bin/sh", entry: printer, pathPrepend: nodeDir, embedEnv: qmdEnvironment(hardware, "embed"), retrievalEnv: qmdEnvironment(hardware, "retrieval") }, "linux"),
    );
    // Stray user settings: device variables are overridden; the model variable is QMD's config's business.
    const env = { PATH: process.env.PATH, QMD_FORCE_CPU: "1", QMD_LLAMA_GPU: "cuda", QMD_EMBED_MODEL: "user-choice" };
    const embed = spawnSync("/bin/sh", [dispatcher, "embed"], { encoding: "utf8", env });
    const query = spawnSync("/bin/sh", [dispatcher, "query", "hello"], { encoding: "utf8", env });
    assert.equal(embed.stdout, "embed|unset|vulkan|user-choice|pinned");
    assert.equal(query.stdout, "query|1|unset|user-choice|pinned");
});

test("the shell PATH block is added once, replaced in place when stale, and migrates the first version's line", () => {
    const line = `export PATH='/h/.local/libexec/local-memory-setup':"$PATH"`;
    const once = withManagedPathBlock("alias ll='ls -l'\n", "local-memory-setup", line);
    assert.equal(once, `alias ll='ls -l'\n\n# local-memory-setup\n${line}\n`);
    assert.equal(managedPathBlockState(once, "local-memory-setup", line), "current");
    assert.equal(withManagedPathBlock(once, "local-memory-setup", line), once);
    const legacy = 'x=1\n\n# local-memory-setup\nexport PATH="/h/.local/libexec/qmd-dispatch:/h/.local/bin:$PATH" # local-memory-setup\ny=2\n';
    assert.equal(managedPathBlockState(legacy, "local-memory-setup", line), "stale");
    const migrated = withManagedPathBlock(legacy, "local-memory-setup", line);
    assert.equal(migrated, `x=1\n\n# local-memory-setup\n${line}\ny=2\n`);
    assert.doesNotMatch(migrated, /qmd-dispatch/);
    assert.equal(withManagedPathBlock("", "local-memory-setup", line), `\n# local-memory-setup\n${line}\n`);
    assert.equal(managedPathBlockState("x=1\n", "local-memory-setup", line), "absent");
});

test("a current block followed by another tool's block (conda init) is still configured, and a rewrite is a no-op", () => {
    const line = `export PATH='/h/.local/libexec/local-memory-setup':"$PATH"`;
    const text = `alias a=b\n\n# local-memory-setup\n${line}\n# >>> conda initialize >>>\n__conda_setup=x\n# <<< conda initialize <<<\n`;
    assert.equal(managedPathBlockState(text, "local-memory-setup", line), "current");
    assert.equal(withManagedPathBlock(text, "local-memory-setup", line), text);
    // Two blocks (one stale) collapse to one current block where the first stood.
    const doubled = `# local-memory-setup\nexport PATH='/old':"$PATH"\nmid=1\n# local-memory-setup\n${line}\n`;
    assert.equal(managedPathBlockState(doubled, "local-memory-setup", line), "stale");
    assert.equal(withManagedPathBlock(doubled, "local-memory-setup", line), `# local-memory-setup\n${line}\nmid=1\n`);
});

test("systemd unit quotes ExecStart and escapes specifiers and variables", () => {
    const unit = systemdUnit({ description: "d", execStart: "/home/a b/100%/$x.sh", wants: [] });
    assert.match(unit, /^ExecStart="\/home\/a b\/100%%\/\$\$x\.sh"$/m);
    assert.doesNotMatch(unit, /^(Wants|After)=/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
});

test("systemd unit orders after the user units it wants", () => {
    const unit = systemdUnit({ description: "d", execStart: "/r.sh", wants: ["local-memory-ollama.service"] });
    assert.match(unit, /^Wants=local-memory-ollama\.service$/m);
    assert.match(unit, /^After=local-memory-ollama\.service$/m);
});

test("LaunchAgent plist escapes paths and keeps the service alive from login", () => {
    const plist = launchAgentPlist({ label: "com.local-memory-setup.qmd", program: "/Users/a&b/qmd.sh", log: "/Users/a&b/qmd.log" });
    assert.match(plist, /<string>\/Users\/a&amp;b\/qmd\.sh<\/string>/);
    assert.doesNotMatch(plist, /a&b/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test("Task Scheduler XML is UTF-16LE with BOM, per-user, and never time-limited or battery-stopped", () => {
    const buffer = windowsTaskXml({ command: "C:\\Users\\a&b\\qmd.cmd", userId: "PC\\a&b" });
    assert.deepEqual([...buffer.subarray(0, 2)], [0xff, 0xfe]);
    const xml = buffer.subarray(2).toString("utf16le");
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
    assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><UserId>PC\\a&amp;b<\/UserId><\/LogonTrigger>/);
    assert.match(xml, /<Principal id="Author"><UserId>PC\\a&amp;b<\/UserId>/);
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
    assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/);
    // The runner starts through a hidden PowerShell window, not as a console of its own.
    const exec = /<Exec><Command>([^<]*)<\/Command><Arguments>([^<]*)<\/Arguments><\/Exec>/.exec(xml);
    assert.ok(exec !== null);
    const unescape = (/** @type {string} */ text) =>
        text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[/** @type {"amp"} */ (name)]);
    assert.equal(exec[1], "powershell.exe");
    assert.equal(unescape(exec[2]), `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& 'C:\\Users\\a&b\\qmd.cmd'"`);
    assert.doesNotMatch(xml, /<Hidden>/);
});

test("the hidden task's PowerShell command quotes the runner path literally", () => {
    const exec = windowsTaskExec("C:\\Users\\o'neil\\$x qmd.cmd");
    assert.equal(exec.command, "powershell.exe");
    assert.equal(exec.args, `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& 'C:\\Users\\o''neil\\$x qmd.cmd'"`);
});

test("renderers are deterministic, so an unchanged install rewrites nothing", () => {
    const spec = { env: [/** @type {const} */ (["A", "1"])], pathPrepend: null, gate: null, argv: ["/x"] };
    assert.equal(runnerScript(spec, "linux"), runnerScript(spec, "linux"));
    assert.ok(windowsTaskXml({ command: "c", userId: "u" }).equals(windowsTaskXml({ command: "c", userId: "u" })));
});

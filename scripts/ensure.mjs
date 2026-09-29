/**
 * Idempotent local install of QMD and CaviraOSS LongMemory.
 *
 * npm package "longmemory" is the old HSG server. This script builds the
 * Hydrograph server from a pinned CaviraOSS commit instead.
 *
 * Fast path: both listeners are healthy. Full path: install, choose models,
 * register a user service that restarts, and wire MCP clients that exist.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chooseModels } from "./model_choice.mjs";
import { appendSections, codexBlocks, grokBlocks } from "./mcp_config.mjs";

const LONGMEMORY_COMMIT = "9ee2c8e1ed42d83eb788afb9ffc3a82b84405da5";
const LONGMEMORY_REPO = "https://github.com/CaviraOSS/LongMemory.git";
const QMD_PORT = 8181;
const LONGMEMORY_PORT = 7331;
const MARKER = "local-memory-setup";

const home = os.homedir();
const share = path.join(home, ".local", "share", MARKER);
const configDir = path.join(home, ".config", MARKER);
const prefix = path.join(home, ".local");
const binDir = path.join(prefix, "bin");
const dispatchDir = path.join(prefix, "libexec", "qmd-dispatch");
const sourceDir = path.join(share, "LongMemory");
const dbPath = path.join(share, "longmemory.db");
const notesDir = path.join(share, "notes");
const envPath = path.join(configDir, "longmemory.env");
const statePath = path.join(share, "state.json");
const nodeBin = process.execPath;

function fail(status, detail, extra = {}) {
    process.stdout.write(`${JSON.stringify({ status, detail, ...extra })}\n`);
    process.exit(status === "needs_admin" ? 2 : 1);
}

function say(message) {
    process.stderr.write(`${message}\n`);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
    });
    if (result.error) {
        throw new Error(`${command}: ${result.error.message}`);
    }
    if (result.status !== 0 && !options.allowFail) {
        const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
        throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${detail}`);
    }
    return result;
}

function commandExists(name) {
    const finder = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [name] : ["-v", name];
    if (process.platform !== "win32") {
        const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
        return result.status === 0;
    }
    const result = run(finder, args, { allowFail: true, silent: true });
    return result.status === 0;
}

function tcpOpen(port) {
    const result = spawnSync(
        nodeBin,
        [
            "-e",
            `const n=require('net');const s=n.connect(${port},'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000);`,
        ],
        { encoding: "utf8" },
    );
    return result.status === 0;
}

function httpOk(urlPath) {
    const result = spawnSync(
        nodeBin,
        [
            "-e",
            `fetch(${JSON.stringify(urlPath)},{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
        ],
        { encoding: "utf8" },
    );
    return result.status === 0;
}

function healthy() {
    return tcpOpen(QMD_PORT) && httpOk(`http://127.0.0.1:${LONGMEMORY_PORT}/health`);
}

function readEnv(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const values = {};
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        values[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return values;
}

function writeEnv(values) {
    fs.mkdirSync(configDir, { recursive: true });
    const body = Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
    fs.writeFileSync(envPath, `${body}\n`, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
}

function probe() {
    const ramBytes = os.totalmem();
    let gpu = "none";
    let vramBytes = 0;
    if (process.platform === "darwin" && process.arch === "arm64") {
        gpu = "apple";
        vramBytes = ramBytes;
    } else if (process.platform === "linux" || process.platform === "win32") {
        const nvidia = spawnSync(
            "nvidia-smi",
            ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            { encoding: "utf8" },
        );
        if (nvidia.status === 0 && nvidia.stdout.trim()) {
            gpu = "nvidia";
            const first = Number(nvidia.stdout.trim().split(/\s+/)[0]);
            if (Number.isFinite(first)) vramBytes = first * 1024 * 1024;
        } else if (process.platform === "linux" && fs.existsSync("/dev/dri/renderD128")) {
            gpu = "other";
        }
    }
    return { ramBytes, vramBytes, gpu };
}

function requireNode() {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) {
        fail("failed", `Node.js >= 22 is required. This process is ${process.versions.node} (${nodeBin}).`);
    }
}

function npmBin(name) {
    if (process.platform === "win32") {
        const cmd = path.join(binDir, `${name}.cmd`);
        if (fs.existsSync(cmd)) return cmd;
    }
    return path.join(binDir, name);
}

function installQmd() {
    const qmd = npmBin("qmd");
    if (!fs.existsSync(qmd)) {
        say("Installing @tobilu/qmd under ~/.local");
        run("npm", ["install", "-g", "--prefix", prefix, "@tobilu/qmd"]);
    }
}

function installLongMemory() {
    fs.mkdirSync(share, { recursive: true });
    if (!fs.existsSync(path.join(sourceDir, ".git"))) {
        say("Cloning CaviraOSS LongMemory");
        run("git", ["clone", LONGMEMORY_REPO, sourceDir]);
    }
    const head = run("git", ["-C", sourceDir, "rev-parse", "HEAD"], { silent: true }).stdout.trim();
    if (head !== LONGMEMORY_COMMIT) {
        const status = run("git", ["-C", sourceDir, "status", "--porcelain"], { silent: true }).stdout.trim();
        if (status) {
            fail("failed", `LongMemory checkout at ${sourceDir} has local changes. Leave it unchanged or move it aside.`);
        }
        say(`Checking out LongMemory ${LONGMEMORY_COMMIT}`);
        run("git", ["-C", sourceDir, "fetch", "--depth", "1", "origin", LONGMEMORY_COMMIT]);
        run("git", ["-C", sourceDir, "checkout", "--detach", "FETCH_HEAD"]);
    }
    const built = path.join(sourceDir, "dist", "cli", "index.js");
    if (!fs.existsSync(built)) {
        const pnpm = npmBin("pnpm");
        if (!fs.existsSync(pnpm)) {
            say("Installing pnpm under ~/.local");
            run("npm", ["install", "-g", "--prefix", prefix, "pnpm"]);
        }
        say("Building LongMemory");
        const buildEnv = { ...process.env, CI: "1" };
        run(npmBin("pnpm"), ["install", "--frozen-lockfile"], { cwd: sourceDir, env: buildEnv });
        run(npmBin("pnpm"), ["build"], { cwd: sourceDir, env: buildEnv });
    }
    if (!fs.existsSync(built)) {
        fail("failed", `LongMemory build did not produce ${built}`);
    }
}

function installOllama(model) {
    if (!commandExists("ollama")) {
        say("Installing Ollama");
        if (process.platform === "linux") {
            const sudo = run("sudo", ["-n", "true"], { allowFail: true, silent: true });
            if (sudo.status !== 0) {
                fail("needs_admin", "Ollama is not installed and sudo is not available.", {
                    command: "curl -fsSL https://ollama.com/install.sh | sh",
                });
            }
            run("/bin/sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sudo -n sh"]);
        } else if (process.platform === "darwin") {
            if (!commandExists("brew")) {
                fail("needs_admin", "Install Homebrew, then Ollama.", {
                    command: "brew install ollama && brew services start ollama",
                });
            }
            run("brew", ["install", "ollama"]);
            run("brew", ["services", "start", "ollama"], { allowFail: true });
        } else {
            run("winget", [
                "install",
                "--id",
                "Ollama.Ollama",
                "-e",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ]);
        }
    }
    if (!commandExists("ollama")) {
        fail("needs_admin", "Ollama was installed but is not on PATH. Open a new terminal and run this skill again.");
    }
    say(`Pulling Ollama model ${model}`);
    run("ollama", ["pull", model]);
}

function writeLongMemoryEnv(choice) {
    const current = readEnv(envPath);
    const apiKey = current.LONGMEMORY_API_KEY || crypto.randomBytes(24).toString("hex");
    writeEnv({
        LONGMEMORY_API_KEY: apiKey,
        LONGMEMORY_HOST: "127.0.0.1",
        LONGMEMORY_PORT: String(LONGMEMORY_PORT),
        LONGMEMORY_DB_PATH: dbPath,
        LONGMEMORY_PROJECT_ID: "local",
        LONGMEMORY_USER_ID: "local",
        LONGMEMORY_EMBEDDING_PROVIDER: "ollama",
        LONGMEMORY_EMBEDDING_TIER: "deep",
        LONGMEMORY_EMBEDDING_DIMENSION: String(choice.longmemory.dimension),
        LONGMEMORY_EMBEDDING_FALLBACK: "synthetic",
        LONGMEMORY_OLLAMA_URL: "http://127.0.0.1:11434",
        LONGMEMORY_OLLAMA_EMBEDDING_MODEL: choice.longmemory.model,
    });
    return apiKey;
}

function writeDispatcher(choice) {
    fs.mkdirSync(dispatchDir, { recursive: true });
    if (process.platform === "win32") {
        const gpu = choice.gpuEmbed ? "set QMD_FORCE_CPU=\r\nset QMD_LLAMA_GPU=vulkan\r\n" : "set QMD_FORCE_CPU=1\r\nset QMD_LLAMA_GPU=\r\n";
        const cpu = "set QMD_FORCE_CPU=1\r\nset QMD_LLAMA_GPU=\r\n";
        const body = `@echo off\r\nsetlocal\r\nif /I "%~1"=="embed" (\r\n${gpu}) else (\r\n${cpu})\r\ncall "${path.join(binDir, "qmd.cmd")}" %*\r\n`;
        fs.writeFileSync(path.join(dispatchDir, "qmd.cmd"), body);
        return;
    }
    const embedGpu = choice.gpuEmbed
        ? process.platform === "darwin"
            ? "unset QMD_FORCE_CPU\nunset QMD_LLAMA_GPU\n"
            : "unset QMD_FORCE_CPU\nexport QMD_LLAMA_GPU=vulkan\n"
        : "export QMD_FORCE_CPU=1\nunset QMD_LLAMA_GPU\n";
    const body = `#!/bin/sh\nREAL="${path.join(binDir, "qmd")}"\nif [ "$1" = "embed" ]; then\n${embedGpu}else\nexport QMD_FORCE_CPU=1\nunset QMD_LLAMA_GPU\nfi\nexec "$REAL" "$@"\n`;
    const file = path.join(dispatchDir, "qmd");
    fs.writeFileSync(file, body, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
}

function prependPath() {
    const entry = process.platform === "win32" ? dispatchDir : `${dispatchDir}:${binDir}`;
    if (process.platform === "win32") {
        const current = process.env.Path || process.env.PATH || "";
        if (current.toLowerCase().includes(dispatchDir.toLowerCase())) return;
        const prefixPath = `${dispatchDir};${binDir};`.replaceAll("'", "''");
        run("powershell", [
            "-NoProfile",
            "-Command",
            `[Environment]::SetEnvironmentVariable('Path', '${prefixPath}' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')`,
        ]);
        return;
    }
    const line = `export PATH="${entry}:$PATH" # ${MARKER}`;
    for (const file of [".zshrc", ".bashrc", ".profile"]) {
        const target = path.join(home, file);
        const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
        if (existing.includes(`# ${MARKER}`)) continue;
        fs.appendFileSync(target, `\n# ${MARKER}\n${line}\n`);
    }
}

function writeRunner() {
    fs.mkdirSync(path.join(share, "bin"), { recursive: true });
    const cli = path.join(sourceDir, "dist", "cli", "index.js");
    if (process.platform === "win32") {
        fs.writeFileSync(
            path.join(share, "bin", "run-qmd.cmd"),
            `@echo off\r\nset QMD_FORCE_CPU=1\r\nset QMD_LLAMA_GPU=\r\n"${path.join(binDir, "qmd.cmd")}" mcp --http --port ${QMD_PORT}\r\n`,
        );
        fs.writeFileSync(
            path.join(share, "bin", "run-longmemory.cmd"),
            `@echo off\r\nfor /f "usebackq tokens=1,* delims==" %%A in ("${envPath}") do set %%A=%%B\r\n"${nodeBin}" "${cli}" --db "${dbPath}" --project local --user local serve --host 127.0.0.1 --port ${LONGMEMORY_PORT} --mcp-http\r\n`,
        );
        return;
    }
    const qmdRunner = path.join(share, "bin", "run-qmd.sh");
    fs.writeFileSync(
        qmdRunner,
        `#!/bin/sh\nexport QMD_FORCE_CPU=1\nunset QMD_LLAMA_GPU\nexport PATH="${path.dirname(nodeBin)}:${binDir}:/usr/bin:/bin"\nexec "${path.join(binDir, "qmd")}" mcp --http --port ${QMD_PORT}\n`,
        { mode: 0o755 },
    );
    fs.chmodSync(qmdRunner, 0o755);
    const memoryRunner = path.join(share, "bin", "run-longmemory.sh");
    fs.writeFileSync(
        memoryRunner,
        `#!/bin/sh\nset -a\n. "${envPath}"\nset +a\nexport PATH="${path.dirname(nodeBin)}:${binDir}:/usr/bin:/bin"\nexec "${nodeBin}" "${cli}" --db "${dbPath}" --project local --user local serve --host 127.0.0.1 --port ${LONGMEMORY_PORT} --mcp-http\n`,
        { mode: 0o755 },
    );
    fs.chmodSync(memoryRunner, 0o755);
}

function installLinuxServices() {
    const unitDir = path.join(home, ".config", "systemd", "user");
    fs.mkdirSync(unitDir, { recursive: true });
    const qmdUnit = path.join(unitDir, "qmd-mcp.service");
    const memoryUnit = path.join(unitDir, "longmemory.service");
    if (!fs.existsSync(qmdUnit)) {
        fs.writeFileSync(
            qmdUnit,
            `[Unit]\nDescription=QMD MCP server (CPU retrieval, HTTP on :${QMD_PORT})\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=QMD_FORCE_CPU=1\nUnsetEnvironment=QMD_LLAMA_GPU\nExecStart=${path.join(share, "bin", "run-qmd.sh")}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`,
        );
    }
    if (!fs.existsSync(memoryUnit)) {
        fs.writeFileSync(
            memoryUnit,
            `[Unit]\nDescription=LongMemory HTTP and MCP on :${LONGMEMORY_PORT}\nAfter=network.target\n\n[Service]\nType=simple\nEnvironmentFile=${envPath}\nExecStart=${path.join(share, "bin", "run-longmemory.sh")}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`,
        );
    }
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "qmd-mcp.service"]);
    run("systemctl", ["--user", "enable", "--now", "longmemory.service"]);
    const linger = run("loginctl", ["enable-linger", os.userInfo().username], { allowFail: true, silent: true });
    return linger.status === 0
        ? "systemd user services, Restart=always, linger enabled so they start at boot"
        : "systemd user services, Restart=always. They start when you log in. For boot before login, run: loginctl enable-linger $USER";
}

function installMacServices() {
    const dir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    const logs = path.join(home, "Library", "Logs", MARKER);
    fs.mkdirSync(logs, { recursive: true });
    const agents = [
        ["com.local-memory-setup.qmd", path.join(share, "bin", "run-qmd.sh"), "qmd.log"],
        ["com.local-memory-setup.longmemory", path.join(share, "bin", "run-longmemory.sh"), "longmemory.log"],
    ];
    const uid = run("/usr/bin/id", ["-u"], { silent: true }).stdout.trim();
    for (const [label, program, logName] of agents) {
        const plist = path.join(dir, `${label}.plist`);
        if (!fs.existsSync(plist)) {
            fs.writeFileSync(
                plist,
                `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${program}</string></array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${path.join(logs, logName)}</string>\n<key>StandardErrorPath</key><string>${path.join(logs, logName)}</string>\n</dict></plist>\n`,
            );
        }
        run("launchctl", ["bootout", `gui/${uid}`, plist], { allowFail: true, silent: true });
        run("launchctl", ["bootstrap", `gui/${uid}`, plist]);
    }
    return "launchd LaunchAgents with KeepAlive. They start at login. macOS user agents do not start before the first login.";
}

function installWindowsTasks() {
    const tasks = [
        ["LocalMemoryQmd", path.join(share, "bin", "run-qmd.cmd")],
        ["LocalMemoryLongMemory", path.join(share, "bin", "run-longmemory.cmd")],
    ];
    const taskDir = path.join(share, "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    for (const [name, command] of tasks) {
        const xmlPath = path.join(taskDir, `${name}.xml`);
        const commandXml = command.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        const xml = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>\n  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n  <Settings>\n    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n    <StartWhenAvailable>true</StartWhenAvailable>\n    <RestartOnFailure><Count>999</Count><Interval>PT1M</Interval></RestartOnFailure>\n    <Enabled>true</Enabled>\n  </Settings>\n  <Actions Context="Author"><Exec><Command>${commandXml}</Command></Exec></Actions>\n</Task>\n`;
        fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
        run("schtasks", ["/Create", "/TN", name, "/XML", xmlPath, "/F"]);
        run("schtasks", ["/Run", "/TN", name], { allowFail: true });
    }
    return "Task Scheduler logon tasks with restart on failure. They start at logon, including the logon after reboot.";
}

function installServices() {
    writeRunner();
    if (process.platform === "linux") return installLinuxServices();
    if (process.platform === "darwin") return installMacServices();
    if (process.platform === "win32") return installWindowsTasks();
    fail("failed", `Unsupported platform ${process.platform}`);
}

function ensureFileSections(filePath, blocks) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const next = appendSections(current, blocks);
    if (next !== current) fs.writeFileSync(filePath, next);
}

function wireMcp(apiKey) {
    ensureFileSections(path.join(home, ".codex", "config.toml"), codexBlocks(apiKey));
    ensureFileSections(path.join(home, ".grok", "config.toml"), grokBlocks(apiKey));
    if (commandExists("claude")) {
        const list = run("claude", ["mcp", "list"], { allowFail: true, timeout: 20000 });
        const text = `${list.stdout || ""}\n${list.stderr || ""}`;
        if (!text.includes("qmd")) {
            run("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "qmd", `http://127.0.0.1:${QMD_PORT}/mcp`], { allowFail: true });
        }
        if (!text.includes("longmemory")) {
            run("claude", [
                "mcp", "add", "--scope", "user", "--transport", "http",
                "--header", `X-API-Key: ${apiKey}`,
                "longmemory", `http://127.0.0.1:${LONGMEMORY_PORT}/mcp`,
            ], { allowFail: true });
        }
    }
    if (commandExists("opencode")) {
        const list = run("opencode", ["mcp", "list"], { allowFail: true, timeout: 20000 });
        const text = `${list.stdout || ""}\n${list.stderr || ""}`;
        if (!text.includes("qmd")) {
            run("opencode", ["mcp", "add", "qmd", "--url", `http://127.0.0.1:${QMD_PORT}/mcp`], { allowFail: true });
        }
        if (!text.includes("longmemory")) {
            run("opencode", ["mcp", "add", "longmemory", "--url", `http://127.0.0.1:${LONGMEMORY_PORT}/mcp`, "--header", `X-API-Key=${apiKey}`], { allowFail: true });
        }
    }
}

function ensureNotesCollection() {
    const status = run(path.join(binDir, "qmd"), ["status"], { allowFail: true, silent: true, env: { ...process.env, QMD_FORCE_CPU: "1" } });
    const text = `${status.stdout || ""}`;
    if (status.status === 0 && (text.includes("qmd://") || /Collections:\s+[1-9]/.test(text))) return;
    fs.mkdirSync(notesDir, { recursive: true });
    const readme = path.join(notesDir, "README.md");
    if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, "# Notes\n\nMarkdown in this folder is indexed by QMD.\n");
    }
    run(path.join(binDir, "qmd"), ["collection", "add", notesDir, "--name", "notes", "--mask", "**/*.md"], {
        allowFail: true,
        env: { ...process.env, QMD_FORCE_CPU: "1" },
    });
}

function waitHealthy() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (healthy()) return true;
        spawnSync(process.platform === "win32" ? "ping" : "sleep", process.platform === "win32" ? ["-n", "2", "127.0.0.1"] : ["1"]);
    }
    return false;
}

function writeState(choice, boot) {
    fs.mkdirSync(share, { recursive: true });
    fs.writeFileSync(
        statePath,
        `${JSON.stringify({
            version: 1,
            ready: true,
            longmemoryCommit: LONGMEMORY_COMMIT,
            qmdModel: choice.qmd.id,
            longmemoryModel: choice.longmemory.model,
            longmemoryDimension: choice.longmemory.dimension,
            gpuEmbed: choice.gpuEmbed,
            boot,
            qmd: `http://127.0.0.1:${QMD_PORT}/mcp`,
            longmemory: `http://127.0.0.1:${LONGMEMORY_PORT}/mcp`,
            env: envPath,
        }, null, 2)}\n`,
    );
}

function main() {
    requireNode();
    if (healthy()) {
        const apiKey = readEnv(envPath).LONGMEMORY_API_KEY;
        if (apiKey) wireMcp(apiKey);
        const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { boot: "already running" };
        process.stdout.write(`${JSON.stringify({ status: "already", ...state })}\n`);
        return;
    }
    if (!commandExists("git")) fail("failed", "git is required to clone CaviraOSS LongMemory.");
    if (!commandExists("npm")) fail("failed", "npm is required. It ships with Node.js 22.");
    const choice = chooseModels(probe());
    say(`QMD model ${choice.qmd.id}; LongMemory model ${choice.longmemory.model} (${choice.longmemory.dimension}-d); GPU embed ${choice.gpuEmbed}`);
    installQmd();
    writeDispatcher(choice);
    prependPath();
    installLongMemory();
    installOllama(choice.longmemory.model);
    const apiKey = writeLongMemoryEnv(choice);
    const boot = installServices();
    wireMcp(apiKey);
    ensureNotesCollection();
    if (!waitHealthy()) {
        fail("failed", `Listeners did not become healthy on 127.0.0.1:${QMD_PORT} and :${LONGMEMORY_PORT}.`, { boot });
    }
    writeState(choice, boot);
    process.stdout.write(`${JSON.stringify({ status: "ready", qmdModel: choice.qmd.id, longmemoryModel: choice.longmemory.model, longmemoryDimension: choice.longmemory.dimension, gpuEmbed: choice.gpuEmbed, boot, env: envPath, qmd: `http://127.0.0.1:${QMD_PORT}/mcp`, longmemory: `http://127.0.0.1:${LONGMEMORY_PORT}/mcp` })}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    try {
        main();
    } catch (error) {
        fail("failed", error instanceof Error ? error.message : String(error));
    }
}

/**
 * Text of every file the installer generates: QMD dispatcher and runners,
 * the LongMemory runner, systemd units, LaunchAgent plists, and Task Scheduler XML.
 * Each renderer owns the quoting rules of its own format. Values a format cannot
 * carry safely raise an error instead of being written half-quoted.
 */
import { quoteWindowsArg, xmlEscape } from "./platform.mjs";

export const MANAGED_MARKER = "Managed by local-memory-setup";

/** @typedef {import("./qmd_env.mjs").EnvSetting} EnvSetting */

/** @param {string} value */
export function shQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** @param {readonly EnvSetting[]} settings */
function shEnv(settings) {
    return settings.map(([name, value]) => (value === null ? `unset ${name}` : `export ${name}=${shQuote(value)}`)).join("\n");
}

/**
 * `set "NAME=value"` in a batch file; an empty value unsets NAME.
 * @param {readonly EnvSetting[]} settings
 */
function cmdEnv(settings) {
    return settings
        .map(([name, value]) => {
            const assignment = `${name}=${value ?? ""}`;
            if (/["%\r\n]/.test(assignment)) throw new Error(`Cannot write ${JSON.stringify(assignment)} into a batch file.`);
            return `set "${assignment}"`;
        })
        .join("\r\n");
}

/**
 * @param {readonly string[]} lines
 */
function cmdFile(lines) {
    return `${lines.join("\r\n")}\r\n`;
}

/**
 * Put `dir` first on PATH. QMD's bin/qmd launcher re-spawns `node` from PATH
 * (2.5.3 bin/qmd: spawn("node", [dist/cli/qmd.js])), so the Node that built QMD's
 * native modules must come first, whatever version manager the shell uses.
 * @param {string} dir
 */
function shPathPrepend(dir) {
    return `export PATH=${shQuote(dir)}:"$PATH"`;
}

/** @param {string} dir */
function cmdPathPrepend(dir) {
    if (/["%\r\n;]/.test(dir)) throw new Error(`Cannot put ${JSON.stringify(dir)} on PATH in a batch file.`);
    return `set "PATH=${dir};%PATH%"`;
}

/**
 * @param {{ node: string, entry: string, pathPrepend: string, embedEnv: readonly EnvSetting[], retrievalEnv: readonly EnvSetting[] }} spec
 * @param {NodeJS.Platform} platform
 */
export function qmdDispatcher(spec, platform) {
    if (platform === "win32") {
        return cmdFile([
            "@echo off",
            `rem ${MANAGED_MARKER}: qmd embed may use the GPU; every other subcommand runs on CPU.`,
            "setlocal",
            cmdPathPrepend(spec.pathPrepend),
            'if /I "%~1"=="embed" (',
            cmdEnv(spec.embedEnv),
            ") else (",
            cmdEnv(spec.retrievalEnv),
            ")",
            `${quoteWindowsArg(spec.node)} ${quoteWindowsArg(spec.entry)} %*`,
        ]);
    }
    return [
        "#!/bin/sh",
        `# ${MANAGED_MARKER}: qmd embed may use the GPU; every other subcommand runs on CPU.`,
        shPathPrepend(spec.pathPrepend),
        'if [ "$1" = "embed" ]; then',
        shEnv(spec.embedEnv),
        "else",
        shEnv(spec.retrievalEnv),
        "fi",
        `exec ${shQuote(spec.node)} ${shQuote(spec.entry)} "$@"`,
        "",
    ].join("\n");
}

/**
 * A service runner: set the environment, optionally block on a readiness gate
 * (a command that exits non-zero while the dependency is not ready), then run the server.
 *
 * POSIX runners exec the server and leave restarts to systemd (Restart=always) or
 * launchd (KeepAlive). The Windows runner loops by itself: Task Scheduler's
 * RestartOnFailure is not a keep-alive for a process that exits, so the batch file
 * reruns the gate and the server, with a 3 s pause, for as long as the task runs.
 * `ping -n 4` is the pause because `timeout` refuses to run without a console stdin.
 * @param {{ env: readonly EnvSetting[], pathPrepend: string | null, gate: readonly string[] | null, argv: readonly string[] }} spec
 * @param {NodeJS.Platform} platform
 */
export function runnerScript(spec, platform) {
    if (platform === "win32") {
        return cmdFile([
            "@echo off",
            `rem ${MANAGED_MARKER}`,
            "setlocal",
            ...(spec.env.length > 0 ? [cmdEnv(spec.env)] : []),
            ...(spec.pathPrepend === null ? [] : [cmdPathPrepend(spec.pathPrepend)]),
            ":run",
            ...(spec.gate === null ? [] : [`${spec.gate.map(quoteWindowsArg).join(" ")} || goto pause`]),
            spec.argv.map(quoteWindowsArg).join(" "),
            ":pause",
            "ping -n 4 127.0.0.1 >nul",
            "goto run",
        ]);
    }
    return [
        "#!/bin/sh",
        `# ${MANAGED_MARKER}`,
        ...(spec.env.length > 0 ? [shEnv(spec.env)] : []),
        ...(spec.pathPrepend === null ? [] : [shPathPrepend(spec.pathPrepend)]),
        ...(spec.gate === null ? [] : [`${spec.gate.map(shQuote).join(" ")} || exit 1`]),
        `exec ${spec.argv.map(shQuote).join(" ")}`,
        "",
    ].join("\n");
}

/**
 * The skill's PATH block in a shell startup file: `# <marker>` followed by `line`.
 * Managed lines are the marker line (with the export line right after it) and the first
 * skill version's export line, which ended in ` # <marker>`.
 * @param {string} text
 * @param {string} marker
 * @param {string} line
 * @returns {"current" | "stale" | "absent"} current: exactly one block, holding `line`,
 *   and no other managed line, wherever in the file it sits
 */
export function managedPathBlockState(text, marker, line) {
    const lines = text.split("\n");
    const markers = lines.flatMap((entry, index) => (entry === `# ${marker}` ? [index] : []));
    const inline = lines.filter((entry) => entry.endsWith(` # ${marker}`)).length;
    if (markers.length === 0 && inline === 0) return "absent";
    return markers.length === 1 && inline === 0 && lines[markers[0] + 1] === line ? "current" : "stale";
}

/**
 * Shell startup file text with exactly one current PATH block. A current block stays
 * where it is (other tools append after it); a stale one is replaced in place, extra
 * managed lines are removed, and the block is appended only when there is none.
 * @param {string} text current file contents ("" when absent)
 * @param {string} marker
 * @param {string} line
 */
export function withManagedPathBlock(text, marker, line) {
    const state = managedPathBlockState(text, marker, line);
    if (state === "current") return text;
    if (state === "absent") {
        const base = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
        return `${base}\n# ${marker}\n${line}\n`;
    }
    const lines = text.split("\n");
    const kept = [];
    let placed = false;
    for (let i = 0; i < lines.length; i += 1) {
        const isMarker = lines[i] === `# ${marker}`;
        if (!isMarker && !lines[i].endsWith(` # ${marker}`)) {
            kept.push(lines[i]);
            continue;
        }
        if (isMarker && /^export PATH=/.test(lines[i + 1] ?? "")) i += 1;
        if (!placed) kept.push(`# ${marker}`, line);
        placed = true;
    }
    return kept.join("\n");
}

/**
 * systemd ExecStart quoting: double quotes, backslash escapes, `%%` for a literal
 * percent (specifiers), `$$` for a literal dollar (variable expansion).
 * @param {string} value
 */
function systemdQuote(value) {
    if (/[\r\n]/.test(value)) throw new Error(`Cannot write ${JSON.stringify(value)} into a systemd unit.`);
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$");
    return `"${escaped}"`;
}

/**
 * `wants` orders this unit after other *user* units; a user unit cannot depend
 * on a system unit such as the install.sh `ollama.service`.
 * @param {{ description: string, execStart: string, wants: readonly string[] }} spec
 */
export function systemdUnit(spec) {
    return [
        `# ${MANAGED_MARKER}`,
        "[Unit]",
        `Description=${spec.description}`,
        ...(spec.wants.length > 0 ? [`Wants=${spec.wants.join(" ")}`, `After=${spec.wants.join(" ")}`] : []),
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${systemdQuote(spec.execStart)}`,
        "Restart=always",
        "RestartSec=3",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}

/**
 * @param {{ label: string, program: string, log: string }} spec
 */
export function launchAgentPlist(spec) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        `<!-- ${MANAGED_MARKER} -->`,
        '<plist version="1.0"><dict>',
        `<key>Label</key><string>${xmlEscape(spec.label)}</string>`,
        `<key>ProgramArguments</key><array><string>${xmlEscape(spec.program)}</string></array>`,
        "<key>RunAtLoad</key><true/>",
        "<key>KeepAlive</key><true/>",
        `<key>StandardOutPath</key><string>${xmlEscape(spec.log)}</string>`,
        `<key>StandardErrorPath</key><string>${xmlEscape(spec.log)}</string>`,
        "</dict></plist>",
        "",
    ].join("\n");
}

/**
 * The task's Exec: the .cmd runner started through powershell.exe with a hidden window,
 * so no console window stays open on the desktop. A .cmd run directly by an interactive
 * logon task gets a visible console; the runner and the server it starts inherit
 * PowerShell's hidden console instead. The task schema's Settings/Hidden is not the
 * switch for this: it "Specifies that the task will not be visible in the UI by default"
 * (learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-hidden-settingstype-element).
 * `-WindowStyle Hidden` "Sets the window style for the session", and -NonInteractive makes
 * a prompt fail instead of waiting (learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_powershell_exe).
 * The console may show for an instant at logon, before PowerShell hides it.
 * @param {string} runner the .cmd file
 */
export function windowsTaskExec(runner) {
    return {
        command: "powershell.exe",
        // A single-quoted PowerShell string is literal except for '' (about_Quoting_Rules).
        args: `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${runner.replaceAll("'", "''")}'"`,
    };
}

/**
 * Logon task for one user. Task Scheduler defaults that would stop a server
 * are overridden: ExecutionTimeLimit defaults to PT72H, and battery power
 * blocks or stops tasks by default. A LogonTrigger without UserId fires for
 * every user and needs administrator rights to register. The runner starts
 * without a visible window (windowsTaskExec).
 * @param {{ command: string, userId: string }} spec `command` is the .cmd runner
 * @returns {Buffer} UTF-16LE with BOM, matching the declared encoding
 */
export function windowsTaskXml(spec) {
    const user = xmlEscape(spec.userId);
    const exec = windowsTaskExec(spec.command);
    const xml = [
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        `  <RegistrationInfo><Description>${MANAGED_MARKER}</Description></RegistrationInfo>`,
        `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
        `  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <StartWhenAvailable>true</StartWhenAvailable>",
        "    <Enabled>true</Enabled>",
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
        "  </Settings>",
        `  <Actions Context="Author"><Exec><Command>${exec.command}</Command><Arguments>${xmlEscape(exec.args)}</Arguments></Exec></Actions>`,
        "</Task>",
        "",
    ].join("\r\n");
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

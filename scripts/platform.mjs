/**
 * Platform facts the installer needs and cannot get from Node alone.
 *
 * npm global layout: executables go to `{prefix}/bin` on Unix and directly
 * into `{prefix}` on Windows; packages go to `{prefix}/lib/node_modules` on
 * Unix and `{prefix}/node_modules` on Windows (npm docs, configuring-npm/folders).
 *
 * Windows process launch: Node refuses to spawn `.cmd`/`.bat` files without a
 * shell (CVE-2024-27980), and npm shims such as `npm`, `pnpm`, `qmd`, `claude`
 * are `.cmd` files. Every Windows command therefore goes through `cmd.exe /d /s /c`
 * with a command line built by `windowsCommandLine`.
 */
import path from "node:path";

/**
 * @param {string} prefix npm `--prefix` directory
 * @param {string} name executable name without extension
 * @param {NodeJS.Platform} platform
 */
export function npmGlobalBin(prefix, name, platform) {
    return platform === "win32" ? path.win32.join(prefix, `${name}.cmd`) : path.posix.join(prefix, "bin", name);
}

/**
 * Directory npm links global executables into for `prefix`.
 * @param {string} prefix
 * @param {NodeJS.Platform} platform
 */
export function npmGlobalBinDir(prefix, platform) {
    return platform === "win32" ? prefix : path.posix.join(prefix, "bin");
}

/**
 * Quote one argument for cmd.exe followed by the MSVCRT argv parser.
 * Rejects characters cmd.exe expands or ends quoting on, instead of guessing.
 * @param {string} value
 */
export function quoteWindowsArg(value) {
    if (/["%\r\n\0]/.test(value)) {
        throw new Error(`Cannot pass ${JSON.stringify(value)} through cmd.exe: it contains ", %, or a line break.`);
    }
    return `"${value.replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * The `/c` payload for `cmd.exe /d /s /c <payload>` with windowsVerbatimArguments.
 * `/s` strips exactly the outer quote pair, leaving each argument quoted.
 * @param {string} command
 * @param {readonly string[]} args
 */
export function windowsCommandLine(command, args) {
    return `"${[command, ...args].map(quoteWindowsArg).join(" ")}"`;
}

/**
 * @param {unknown} bin package.json `bin` field
 * @param {string} name
 * @returns {string} entry path relative to the package directory
 */
export function binEntry(bin, name) {
    if (typeof bin === "string") return bin;
    if (typeof bin === "object" && bin !== null && typeof (/** @type {Record<string, unknown>} */ (bin))[name] === "string") {
        return /** @type {Record<string, string>} */ (bin)[name];
    }
    throw new Error(`package.json has no bin entry named ${name}.`);
}

/** @param {string} value */
export function xmlEscape(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

/**
 * Whether a Node version string (process.versions.node) is at least `min`.
 * @param {string} version
 * @param {{ major: number, minor: number }} min
 */
export function nodeAtLeast(version, min) {
    const [major, minor] = version.split(".").map(Number);
    return major > min.major || (major === min.major && minor >= min.minor);
}

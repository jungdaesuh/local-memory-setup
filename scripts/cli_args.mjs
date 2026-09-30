/**
 * Command line of ensure.mjs: exactly one mode, and the apply inputs only with --apply.
 */

export class UsageError extends Error {}

/**
 * @param {readonly string[]} argv arguments after the script path
 * @returns {{ mode: "--plan" | "--apply" | "--check" | "--update", yes: boolean, choicesFile: string | undefined }}
 */
export function parseArgs(argv) {
    const modes = argv.filter((arg) => arg === "--plan" || arg === "--apply" || arg === "--check" || arg === "--update");
    if (modes.length > 1) throw new UsageError("Use one of --plan, --apply, --check, --update.");
    const mode = /** @type {"--plan" | "--apply" | "--check" | "--update"} */ (modes[0] ?? "--check");
    const choicesIndex = argv.indexOf("--choices");
    const choicesFile = choicesIndex >= 0 && choicesIndex + 1 < argv.length && !argv[choicesIndex + 1].startsWith("--") ? argv[choicesIndex + 1] : undefined;
    if (choicesIndex >= 0 && choicesFile === undefined) throw new UsageError("--choices needs a file path.");
    const known = new Set(["--plan", "--apply", "--check", "--update", "--yes", "--choices", ...(choicesFile === undefined ? [] : [choicesFile])]);
    const unknown = argv.find((arg) => !known.has(arg));
    if (unknown !== undefined) throw new UsageError(`Unknown argument ${unknown}.`);
    const yes = argv.includes("--yes");
    if (mode === "--apply" && yes === (choicesFile !== undefined)) throw new UsageError("--apply needs exactly one of --yes or --choices <file>.");
    if (mode !== "--apply" && (yes || choicesFile !== undefined)) throw new UsageError("--yes and --choices only go with --apply.");
    return { mode, yes, choicesFile };
}

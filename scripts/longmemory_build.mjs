/**
 * Build contract of the pinned LongMemory commit: its package.json pins the
 * package manager (`"packageManager": "pnpm@11.5.2"`), and upstream CI and the
 * Dockerfile build with exactly that pnpm (corepack / pnpm/action-setup).
 */

/**
 * @param {string} packageJsonText contents of the checkout's package.json
 * @returns {string} exact pnpm version
 */
export function pinnedPnpmVersion(packageJsonText) {
    const manager = JSON.parse(packageJsonText).packageManager;
    const match = typeof manager === "string" ? /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(manager) : null;
    if (!match) throw new Error(`LongMemory package.json packageManager is ${JSON.stringify(manager)}, not an exact pnpm version.`);
    return match[1];
}


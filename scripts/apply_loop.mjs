/**
 * The apply sequence, separated from the executors so it can be tested with fakes:
 * run the pending actions in plan order, let an admin-only step that nothing else
 * depends on report NeedsAdmin without stopping the rest, verify, and only then
 * save the choices.
 */

/** An administrator step the script cannot run without a password. */
export class NeedsAdmin extends Error {
    /** @param {string} detail @param {string[]} commands */
    constructor(detail, commands) {
        super(detail);
        this.commands = commands;
    }
}

/**
 * A step that failed, named so the user knows where apply stopped. Every step is
 * idempotent, so the same apply command retries from the first step not yet done.
 */
export class StepFailed extends Error {
    /** @param {string} id @param {unknown} cause */
    constructor(id, cause) {
        super(`Step ${id} failed: ${cause instanceof Error ? cause.message : String(cause)} Fix the cause, then run the same --apply command again to retry; finished steps are skipped.`, { cause });
        this.id = id;
    }
}

/**
 * Actions whose NeedsAdmin is reported after the rest has run. Start-at-boot only
 * changes when user services start; everything else works without it.
 */
export const DEFERRABLE_ADMIN = new Set(["enable-boot-start"]);

/**
 * @template {{ id: string }} A
 * @param {{
 *   pending: readonly A[],
 *   execute: (action: A) => Promise<void>,
 *   remainingAfter: () => Promise<{ id: string, problem: string }[]>,
 *   persist: () => void,
 * }} steps
 * @returns {Promise<NeedsAdmin[]>} deferred admin steps; empty when everything is done
 */
export async function runApply(steps) {
    /** @type {NeedsAdmin[]} */
    const deferred = [];
    /** @type {Set<string>} */
    const deferredIds = new Set();
    for (const action of steps.pending) {
        try {
            await steps.execute(action);
        } catch (error) {
            if (!(error instanceof NeedsAdmin)) throw new StepFailed(action.id, error);
            if (!DEFERRABLE_ADMIN.has(action.id)) throw error;
            deferred.push(error);
            deferredIds.add(action.id);
        }
    }
    const remaining = (await steps.remainingAfter()).filter((action) => !deferredIds.has(action.id));
    if (remaining.length > 0) throw new Error(`Setup finished but these problems remain: ${remaining.map((action) => action.problem).join(" ")}`);
    // Saved only now, when everything but a deferred admin step works: after a failed apply
    // --check reports the setup as not done yet. (The model-size lock comes from stored
    // LongMemory memories, not from this file.)
    steps.persist();
    return deferred;
}

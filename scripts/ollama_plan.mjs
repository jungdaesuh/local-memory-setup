/**
 * Who runs `ollama serve` at boot or login. Exactly one owner per machine,
 * because two servers on 127.0.0.1:11434 conflict.
 *
 * - Linux: the official install.sh writes and enables a system `ollama.service`
 *   (starts at boot). When it exists the skill only makes sure it is enabled and
 *   active. Without it the skill runs its own systemd user unit.
 * - macOS: the Ollama.app (official zip/dmg, or the `ollama-app` cask) registers a
 *   login item, and `brew services start ollama` registers `homebrew.mxcl.ollama`.
 *   Either one owns the server. Otherwise the skill runs its own LaunchAgent on the
 *   headless binary from the Homebrew `ollama` formula.
 * - Windows: OllamaSetup.exe (also what `winget install Ollama.Ollama` runs) installs
 *   `ollama app.exe`, which registers a login item. When it is installed, it owns
 *   the server. A standalone `ollama.exe` (zip) gets the skill's own logon task.
 *
 * Sources: ollama docs/linux.mdx, docs/macos.mdx, docs/windows.mdx, docs/faq.mdx
 * ("Ollama for Windows and macOS register as a login item during installation"),
 * scripts/install.sh configure_systemd, Homebrew formula `ollama` service block.
 */

/**
 * @typedef {{ platform: "linux", systemUnitLoaded: boolean }
 *   | { platform: "darwin", ollamaApp: boolean, brewService: boolean }
 *   | { platform: "win32", ollamaApp: boolean }} OllamaFacts
 * @typedef {{ owner: "system-unit" } | { owner: "external", by: string } | { owner: "skill" }} OllamaPlan
 */

/**
 * @param {OllamaFacts} facts
 * @returns {OllamaPlan}
 */
export function ollamaServicePlan(facts) {
    if (facts.platform === "linux") return facts.systemUnitLoaded ? { owner: "system-unit" } : { owner: "skill" };
    if (facts.platform === "darwin") {
        if (facts.brewService) return { owner: "external", by: "brew services (homebrew.mxcl.ollama)" };
        if (facts.ollamaApp) return { owner: "external", by: "the Ollama app login item" };
        return { owner: "skill" };
    }
    return facts.ollamaApp ? { owner: "external", by: "the Ollama app login item" } : { owner: "skill" };
}

/**
 * True when the model names from GET /api/tags include `model`. Ollama reports
 * an untagged pull as `<name>:latest`.
 * @param {readonly string[]} names
 * @param {string} model
 */
export function ollamaHasModel(names, model) {
    return names.includes(model.includes(":") ? model : `${model}:latest`);
}

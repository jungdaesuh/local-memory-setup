/**
 * QMD's index.yml, read without running QMD (any QMD command rewrites index.yml's models
 * block and may create the index), and the one write this setup makes to it: a models
 * block for a new index. QMD's model cache is never written: QMD downloads each model
 * itself the first time it needs it. The setup only checks, read-only, whether a model's
 * file is already there, to state the first-use download size.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * The file name node-llama-cpp gives a model in QMD's cache, or null for a URI form this
 * setup does not name (and whose download state it then reports as unknown). For
 * `hf:<owner>/<repo>/<file>.gguf` with plain names, node-llama-cpp 3.x
 * (dist/utils/parseModelUri.js buildHuggingFaceFilePrefix) builds
 * `hf_<owner>_[<repo>_]<file>`, leaving out the repo when the repo ends in "-GGUF" and the
 * file name starts with the repo name before it (case-insensitively). Branches, folders,
 * split files, and `:quant` shorthands are not modelled.
 * @param {string} uri
 * @returns {string | null}
 */
export function qmdModelCacheFile(uri) {
    const match = /^hf:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+\.gguf)$/.exec(uri);
    if (!match || /-\d{5}-of-\d{5}\.gguf$/i.test(match[3])) return null;
    const [, owner, repo, file] = match;
    const repoStem = repo.toLowerCase().endsWith("-gguf") ? repo.slice(0, -"-gguf".length).toLowerCase() : null;
    const repoImplied = repoStem !== null && file.slice(0, -".gguf".length).toLowerCase().startsWith(repoStem);
    return repoImplied ? `hf_${owner}_${file}` : `hf_${owner}_${repo}_${file}`;
}

/**
 * Collections in QMD's index.yml: `collections:` maps a name to `path:` and `pattern:`.
 * @param {string} yaml
 * @returns {{ name: string, path: string }[]}
 */
export function qmdCollections(yaml) {
    const collections = [];
    let inCollections = false;
    let current = null;
    for (const line of yaml.split(/\r?\n/)) {
        if (/^\S/.test(line)) {
            inCollections = /^collections:\s*$/.test(line);
            current = null;
            continue;
        }
        if (!inCollections) continue;
        const name = /^ {2}([^\s:][^:]*):\s*$/.exec(line);
        if (name) {
            current = name[1];
            continue;
        }
        const folder = /^ {4}path:\s*(.+?)\s*$/.exec(line);
        if (folder && current !== null) {
            collections.push({ name: current, path: folder[1].replace(/^"(.*)"$|^'(.*)'$/, "$1$2") });
        }
    }
    return collections;
}

/**
 * A collection name for `folder` that is not already taken.
 * @param {string} folder absolute path
 * @param {readonly string[]} taken
 */
export function collectionNameFor(folder, taken) {
    const base = (folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "notes").toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "notes";
    let name = base;
    for (let suffix = 2; taken.includes(name); suffix += 1) name = `${base}-${suffix}`;
    return name;
}

/**
 * @typedef {{ embed?: string, generate?: string, rerank?: string }} QmdModels
 */

/**
 * The top-level `models:` block of index.yml, or null when there is none.
 * QMD resolves each role as `config.models.<role> || QMD_<ROLE>_MODEL || default`
 * (dist/llm.js resolveEmbedModel), and every CLI command writes the resolved models
 * back (dist/cli/qmd.js ensureModelsConfiguredForCli), so this block, once present,
 * is the one source of truth for which models QMD uses.
 * @param {string} yaml
 * @returns {QmdModels | null}
 */
export function qmdConfiguredModels(yaml) {
    /** @type {QmdModels | null} */
    let models = null;
    let inModels = false;
    for (const line of yaml.split(/\r?\n/)) {
        if (/^\S/.test(line)) {
            inModels = /^models:\s*$/.test(line);
            if (inModels) models = {};
            continue;
        }
        const entry = inModels ? /^ {2}(embed|generate|rerank):\s*(.+?)\s*$/.exec(line) : null;
        if (entry && models !== null) models[/** @type {"embed" | "generate" | "rerank"} */ (entry[1])] = entry[2].replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
    }
    return models;
}

/**
 * Write the models block into QMD's index.yml when it has none; leave it otherwise.
 * The file is QMD's, so it is updated in place (a symlinked config stays a symlink).
 * @param {string} file index.yml path
 * @param {Required<QmdModels>} models
 * @returns {boolean} whether the file was written
 */
export function writeQmdModelsIfAbsent(file, models) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (qmdConfiguredModels(current) !== null) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, withQmdModels(current, models));
    return true;
}

/**
 * `yaml` with a `models:` block naming all three roles, in the layout QMD's own
 * saveConfig writes. Only for an index.yml that has no models block yet.
 * @param {string} yaml current index.yml text ("" when the file does not exist)
 * @param {Required<QmdModels>} models
 */
export function withQmdModels(yaml, models) {
    if (qmdConfiguredModels(yaml) !== null) throw new Error("index.yml already has a models block; QMD's configured models are left as they are.");
    for (const uri of Object.values(models)) if (/[\r\n#]|^\s|\s$/.test(uri)) throw new Error(`Model ${JSON.stringify(uri)} cannot be written as a plain YAML value.`);
    const prefix = yaml.length === 0 || yaml.endsWith("\n") ? yaml : `${yaml}\n`;
    return `${prefix}models:\n  embed: ${models.embed}\n  generate: ${models.generate}\n  rerank: ${models.rerank}\n`;
}

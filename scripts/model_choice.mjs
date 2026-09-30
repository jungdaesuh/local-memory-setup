/**
 * Free local embedding models, grouped into three tiers the user picks from.
 * QMD retrieval runs on CPU, so the QMD model must fit in RAM, not only in VRAM.
 * LongMemory embeds through Ollama. Dimensions are the models' native sizes.
 *
 * A tier is chosen once per machine and then kept (see plan.mjs validateChoices):
 * vectors from two embedding models are not comparable, so a later run must not
 * switch models under an existing index.
 */

export const QMD_MODELS = {
    gemma: {
        id: "embeddinggemma-300M-Q8_0",
        // QMD's built-in default embed model (dist/llm.js DEFAULT_EMBED_MODEL).
        uri: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
    },
    qwen06: {
        id: "Qwen3-Embedding-0.6B-Q8_0",
        uri: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    },
    qwen8: {
        id: "Qwen3-Embedding-8B-Q8_0",
        uri: "hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf",
    },
};

/**
 * What QMD uses for a role its index.yml `models` block leaves out and no env var sets.
 * Identical in 2.5.3 and 2.8.3 (dist/llm.js DEFAULT_*_MODEL).
 */
export const QMD_DEFAULT_MODELS = {
    embed: QMD_MODELS.gemma.uri,
    generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
    rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
};

export const LONGMEMORY_MODELS = {
    nomic: { model: "nomic-embed-text", dimension: 768 },
    bge: { model: "bge-m3", dimension: 1024 },
};

/** @typedef {"small" | "medium" | "large"} ModelTier */

export const MODEL_TIERS = {
    small: {
        qmd: QMD_MODELS.gemma,
        longmemory: LONGMEMORY_MODELS.nomic,
        description: "For computers with under 8 GB of memory. Note search: a small, fast model, best with English. Agent memory: a light model, best with English. Smallest download.",
    },
    medium: {
        qmd: QMD_MODELS.qwen06,
        longmemory: LONGMEMORY_MODELS.bge,
        description: "Fits most laptops. Note search: a mid-size model with good results in many languages. Agent memory: a multilingual model that recalls well across languages.",
    },
    large: {
        qmd: QMD_MODELS.qwen8,
        longmemory: LONGMEMORY_MODELS.bge,
        description: "For computers with 32 GB of memory and either a graphics card with 12 GB or more or an Apple Silicon chip. Note search: the most accurate model, a little slower per search. Agent memory: the same multilingual model as Medium. Largest download.",
    },
};

export const TIER_IDS = /** @type {readonly ModelTier[]} */ (Object.keys(MODEL_TIERS));

const GIB = 1024 * 1024 * 1024;

/**
 * The OS reports less memory than the nominal size printed on the machine
 * (firmware and kernel reservations; a 32 GB Linux box reports about 30.7 GiB,
 * a 12 GB GPU about 11.99 GiB). Compare against nominal classes with that slack.
 */
const REPORTED_FRACTION_OF_NOMINAL = 0.9;

function atLeastNominal(reportedBytes, nominalGb) {
    return reportedBytes / GIB >= nominalGb * REPORTED_FRACTION_OF_NOMINAL;
}

/**
 * @typedef {{ ramBytes: number, vramBytes: number, gpu: "nvidia" | "apple" | "other" | "none" }} Hardware
 * @param {Hardware} hardware
 * @returns {ModelTier}
 */
export function recommendTier(hardware) {
    if (!atLeastNominal(hardware.ramBytes, 8)) return "small";
    if (atLeastNominal(hardware.ramBytes, 32) && atLeastNominal(hardware.vramBytes, 12)) return "large";
    return "medium";
}

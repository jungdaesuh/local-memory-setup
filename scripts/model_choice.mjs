/**
 * Free local embedding choices for QMD and LongMemory.
 * QMD retrieval runs on CPU, so the QMD model must fit in RAM, not only in VRAM.
 * LongMemory embeds through Ollama. Dimensions are the models' native sizes.
 */

export const QMD_MODELS = {
    gemma: {
        id: "embeddinggemma-300M-Q8_0",
        env: null,
    },
    qwen06: {
        id: "Qwen3-Embedding-0.6B-Q8_0",
        env: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    },
    qwen8: {
        id: "Qwen3-Embedding-8B-Q8_0",
        env: "hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf",
    },
};

export const LONGMEMORY_MODELS = {
    nomic: { model: "nomic-embed-text", dimension: 768 },
    bge: { model: "bge-m3", dimension: 1024 },
};

/**
 * @param {{ ramBytes: number, vramBytes: number, gpu: "nvidia" | "apple" | "other" | "none" }} hardware
 */
export function chooseModels(hardware) {
    const ramGb = hardware.ramBytes / (1024 * 1024 * 1024);
    const vramGb = hardware.vramBytes / (1024 * 1024 * 1024);
    const gpuEmbed = hardware.gpu !== "none";
    const large =
        ramGb >= 32 &&
        (vramGb >= 12 || (hardware.gpu === "apple" && ramGb >= 32));
    const qmd = ramGb < 8 ? QMD_MODELS.gemma : large ? QMD_MODELS.qwen8 : QMD_MODELS.qwen06;
    const longmemory =
        ramGb < 8 && hardware.gpu === "none" ? LONGMEMORY_MODELS.nomic : LONGMEMORY_MODELS.bge;
    return { qmd, longmemory, gpuEmbed, ramGb, vramGb, gpu: hardware.gpu };
}

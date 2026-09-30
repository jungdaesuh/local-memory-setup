/**
 * Approximate download sizes, in bytes, of the artifacts an install fetches.
 * Measured 2026-09-29; each number names its source. Sizes drift with upstream
 * releases, so the plan presents them as approximations.
 */

/** GGUF files QMD downloads on first use, from the Hugging Face tree API `lfs.size`. */
export const QMD_MODEL_BYTES = {
    // huggingface.co/api/models/ggml-org/embeddinggemma-300M-GGUF/tree/main
    "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf": 333_590_944,
    // huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B-GGUF/tree/main
    "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf": 639_150_592,
    // huggingface.co/api/models/Qwen/Qwen3-Embedding-8B-GGUF/tree/main
    "hf:Qwen/Qwen3-Embedding-8B-GGUF/Qwen3-Embedding-8B-Q8_0.gguf": 8_047_105_824,
    // QMD 2.5.3 DEFAULT_RERANK_MODEL; huggingface.co/api/models/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/tree/main
    "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf": 639_153_184,
    // QMD 2.5.3 DEFAULT_GENERATE_MODEL; huggingface.co/api/models/tobil/qmd-query-expansion-1.7B-gguf/tree/main
    "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf": 1_282_438_912,
};

/** Ollama models: sum of layer sizes in registry.ollama.ai/v2/library/<name>/manifests/latest. */
export const OLLAMA_MODEL_BYTES = {
    "nomic-embed-text": 274_302_450,
    "bge-m3": 1_157_672_605,
};

/**
 * `npm install -g @tobilu/qmd@2.5.3`: registry tarball sizes (ranged GET content-range).
 * Dominated by node-llama-cpp 3.18.1 (28,988,949) and its per-platform prebuilt
 * binaries: linux x64 = x64 7,729,107 + cuda 125,186,101 + cuda-ext 194,622,910 +
 * vulkan 24,686,279 (+ arm builds npm also fetches); win x64 = x64 7,344,428 +
 * cuda 121,455,259 + cuda-ext 193,719,395 + vulkan 24,304,688; mac arm64 = metal 1,901,048.
 * About 20 MB of other dependencies (tree-sitter grammars, typescript, better-sqlite3).
 * @type {Readonly<Record<string, number>>}
 */
export const QMD_PACKAGE_BYTES = {
    linux: 405_000_000,
    win32: 400_000_000,
    darwin: 55_000_000,
};

/**
 * LongMemory at the pinned commit:
 * - git clone: 6,222,035 (du of a full clone's .git)
 * - pnpm 11.5.2 tarball: 4,286,375 (registry.npmjs.org/pnpm/-/pnpm-11.5.2.tgz)
 * - `pnpm install --frozen-lockfile`: at most 533,927,351, the sum of the registry
 *   tarballs of all 895 packages in pnpm-lock.yaml (an upper bound: pnpm skips
 *   other platforms' optional binaries).
 */
export const LONGMEMORY_BUILD_BYTES = 6_222_035 + 4_286_375 + 533_927_351;

/**
 * install.sh extras on Linux (install.sh check_gpu): with an AMD GPU it also fetches
 * ollama-linux-amd64-rocm.tar.zst (ranged GET: 1,052,074,405); with an NVIDIA GPU and no
 * working driver it adds NVIDIA's CUDA repository and installs cuda-drivers (size set by
 * the distribution's packages).
 */
export const OLLAMA_ROCM_BYTES = 1_052_074_405;

/**
 * Ollama installers (HEAD content-length unless noted):
 * - Linux install.sh fetches ollama.com/download/ollama-linux-amd64.tar.zst 1,427,703,051
 *   (arm64: 1,549,684,612).
 * - macOS Homebrew `ollama` formula bottle arm64_tahoe 15,479,334 (ghcr.io blob).
 * - Windows winget runs OllamaSetup.exe 1,571,115,536.
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 */
export function ollamaInstallerBytes(platform, arch) {
    if (platform === "linux") return arch === "arm64" ? 1_549_684_612 : 1_427_703_051;
    if (platform === "darwin") return 15_479_334;
    return 1_571_115_536;
}

/**
 * Time limit for a download of `bytes`: ten minutes plus the time it takes at 1 MB/s.
 * A pull that makes no progress (offline, a stuck proxy) would otherwise never end.
 * @param {number} bytes
 */
export function downloadTimeoutMs(bytes) {
    return 10 * 60_000 + Math.ceil(bytes / 1_000_000) * 1000;
}

/**
 * Time limit for an install step that downloads `bytes` and then builds or configures:
 * native modules compiled from source when no prebuilt one fits, TypeScript builds,
 * distribution packages (install.sh's driver packages). The download limit plus twenty
 * minutes.
 * @param {number} bytes
 */
export function installTimeoutMs(bytes) {
    return downloadTimeoutMs(bytes) + 20 * 60_000;
}

/** Time limit for an agent CLI's `mcp add`, which only edits that agent's config file. */
export const MCP_ADD_TIMEOUT_MS = 2 * 60_000;

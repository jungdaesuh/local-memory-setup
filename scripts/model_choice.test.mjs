import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_TIERS, TIER_IDS, recommendTier } from "./model_choice.mjs";
import { OLLAMA_MODEL_BYTES, QMD_MODEL_BYTES } from "./sizes.mjs";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

test("machines below 8 GB get the small tier", () => {
    assert.equal(recommendTier({ ramBytes: 7 * GIB, vramBytes: 0, gpu: "none" }), "small");
    assert.equal(recommendTier({ ramBytes: 4 * GIB, vramBytes: 4 * GIB, gpu: "nvidia" }), "small");
});

test("a nominal 8 GB Linux box, which reports about 7.7 GiB, is not small", () => {
    assert.equal(recommendTier({ ramBytes: 7.7 * GIB, vramBytes: 0, gpu: "none" }), "medium");
});

test("a nominal 32 GB Linux box with a 12 GB card, as reported, gets the large tier", () => {
    // os.totalmem on a 32 GB Linux machine: about 30.7 GiB. RTX 4070 12 GB: nvidia-smi 12282 MiB.
    assert.equal(recommendTier({ ramBytes: 30.7 * GIB, vramBytes: 12282 * MIB, gpu: "nvidia" }), "large");
    // This workstation: 131962425344 bytes RAM, 32607 MiB VRAM.
    assert.equal(recommendTier({ ramBytes: 131_962_425_344, vramBytes: 32_607 * MIB, gpu: "nvidia" }), "large");
});

test("large needs both the memory and the GPU", () => {
    assert.equal(recommendTier({ ramBytes: 64 * GIB, vramBytes: 8 * GIB, gpu: "nvidia" }), "medium");
    assert.equal(recommendTier({ ramBytes: 16 * GIB, vramBytes: 24 * GIB, gpu: "nvidia" }), "medium");
    assert.equal(recommendTier({ ramBytes: 64 * GIB, vramBytes: 0, gpu: "none" }), "medium");
});

test("Apple silicon counts unified memory as GPU memory", () => {
    assert.equal(recommendTier({ ramBytes: 32 * GIB, vramBytes: 32 * GIB, gpu: "apple" }), "large");
    assert.equal(recommendTier({ ramBytes: 16 * GIB, vramBytes: 16 * GIB, gpu: "apple" }), "medium");
});

test("every tier names models that have a known download size", () => {
    for (const id of TIER_IDS) {
        assert.ok(QMD_MODEL_BYTES[MODEL_TIERS[id].qmd.uri] > 0, `${id} QMD model size`);
        assert.ok(OLLAMA_MODEL_BYTES[MODEL_TIERS[id].longmemory.model] > 0, `${id} Ollama model size`);
    }
});

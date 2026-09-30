import assert from "node:assert/strict";
import test from "node:test";
import { qmdEnvironment } from "./qmd_env.mjs";
import { systemdUnit, launchAgentPlist } from "./service_files.mjs";
import { longMemorySettings } from "./longmemory_env.mjs";

test("QMD device policy also removes inherited HTTP bind and origin overrides", () => {
    for (const mode of ["embed", "retrieval"]) {
        const settings = new Map(qmdEnvironment({ gpu: "nvidia" }, mode));
        for (const name of ["QMD_HOST", "QMD_ALLOWED_ORIGINS", "QMD_ALLOWED_HOSTS"]) assert.equal(settings.get(name), null, `${name} must not survive the managed launcher`);
    }
});

test("LongMemory settings never enable an unauthenticated HTTP transport", () => {
    const settings = new Map(longMemorySettings({ dbPath: "/private/memory.db", model: "bge-m3", dimension: 1024 }));
    assert.equal(settings.get("LONGMEMORY_MCP_HTTP"), "false");
});

test("remaining user services restrict new file permissions on Linux and macOS", () => {
    assert.match(systemdUnit({ description: "private", execStart: "/runner", wants: [] }), /^UMask=0077$/m);
    assert.match(launchAgentPlist({ label: "private", program: "/runner", log: "/log" }), /<key>Umask<\/key><integer>63<\/integer>/);
});

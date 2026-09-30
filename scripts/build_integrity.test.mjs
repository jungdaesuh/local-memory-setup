import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArtifactFingerprint } from "./build_integrity.mjs";
import { longMemoryStamp } from "./layout.mjs";

/** @param {(root: string) => void} operation */
function withBuild(operation) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-build-integrity-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"longmemory"}\n');
    fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{}}\n');
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
    fs.writeFileSync(path.join(root, "dist", "cli", "index.js"), "process.stdout.write('ready');\n");
    fs.writeFileSync(path.join(root, "longmemory_stdio.mjs"), 'import { run_mcp_stdio } from "./dist/mcp/transports/stdio.js";\n');
    fs.writeFileSync(path.join(root, "node_modules", ".package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
    try {
        operation(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test("the artifact fingerprint is stable and excludes the receipt and build noise", () => {
    withBuild((root) => {
        const initial = buildArtifactFingerprint(root);
        fs.writeFileSync(longMemoryStamp(root), '{"commit":"ignored receipt"}\n');
        fs.mkdirSync(path.join(root, "src", ".git"));
        fs.writeFileSync(path.join(root, "src", ".git", "HEAD"), "noise 1\n");
        fs.mkdirSync(path.join(root, "dist", ".cache"));
        fs.writeFileSync(path.join(root, "dist", ".cache", "generated"), "noise 1\n");
        fs.mkdirSync(path.join(root, "src", "logs"));
        fs.writeFileSync(path.join(root, "src", "logs", "setup.log"), "noise 1\n");
        fs.writeFileSync(path.join(root, "dist", "build.log.1"), "noise 1\n");
        assert.equal(buildArtifactFingerprint(root), initial);
        fs.writeFileSync(path.join(root, "dist", ".cache", "generated"), "noise 2\n");
        fs.writeFileSync(path.join(root, "src", "logs", "setup.log"), "noise 2\n");
        assert.equal(buildArtifactFingerprint(root), initial);
    });
});

test("changes to source, build output, manifests, and npm's hidden lock change the receipt", () => {
    withBuild((root) => {
        const initial = buildArtifactFingerprint(root);
        for (const [file, replacement] of [
            [path.join(root, "src", "index.ts"), "export const answer = 43;\n"],
            [path.join(root, "dist", "cli", "index.js"), "process.stdout.write('changed');\n"],
            [path.join(root, "package.json"), '{"name":"changed"}\n'],
            [path.join(root, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n'],
            [path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n'],
            [path.join(root, "longmemory_stdio.mjs"), 'import { run_mcp_stdio } from "./dist/mcp/transports/other.js";\n'],
            [path.join(root, "node_modules", ".package-lock.json"), '{"lockfileVersion":3,"packages":{"x":{}}}\n'],
        ]) {
            const original = fs.readFileSync(file, "utf8");
            fs.writeFileSync(file, replacement);
            assert.notEqual(buildArtifactFingerprint(root), initial, `${path.relative(root, file)} must be covered`);
            fs.writeFileSync(file, original);
        }
    });
});

test("internal source symlinks are recorded and links leaving the build are rejected", { skip: process.platform === "win32" }, () => {
    withBuild((root) => {
        const alias = path.join(root, "dist", "cli", "alias.js");
        fs.symlinkSync("index.js", alias);
        const linked = buildArtifactFingerprint(root);
        fs.unlinkSync(alias);
        assert.notEqual(buildArtifactFingerprint(root), linked);

        const escaping = path.join(root, "dist", "cli", "outside.js");
        fs.symlinkSync(path.join(root, "..", "outside.js"), escaping);
        assert.throws(() => buildArtifactFingerprint(root), /symlink escapes its root/);
    });
});

test("all reviewed artifact inputs must exist as regular files or directories", () => {
    withBuild((root) => {
        fs.rmSync(path.join(root, "node_modules", ".package-lock.json"));
        assert.throws(() => buildArtifactFingerprint(root), /ENOENT/);
    });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OLLAMA_INSTALL_SHA256, OLLAMA_VERSION, assertSha256Match, fileSha256, ollamaAdminCommand, ollamaInstallScriptUrl } from "./layout.mjs";

/** SHA-256 of https://raw.githubusercontent.com/ollama/ollama/v0.34.4/scripts/install.sh on 2026-09-30. */
const PINNED = "25f64b810b947145095956533e1bdf56eacea2673c55a7e586be4515fc882c9f";
const URL = "https://raw.githubusercontent.com/ollama/ollama/v0.34.4/scripts/install.sh";

test("the manual Ollama command downloads the tagged installer and checks the pin before sh", () => {
    assert.equal(OLLAMA_VERSION, "0.34.4");
    assert.equal(OLLAMA_INSTALL_SHA256, PINNED);
    assert.equal(ollamaInstallScriptUrl(OLLAMA_VERSION), URL);
    assert.equal(
        ollamaAdminCommand(OLLAMA_VERSION),
        `curl -fsSL -o install.sh ${URL} && echo "${PINNED}  install.sh" | sha256sum -c - && OLLAMA_VERSION=0.34.4 sh install.sh`,
    );
    assert.doesNotMatch(ollamaAdminCommand(OLLAMA_VERSION), /ollama\.com\/install\.sh/);
    assert.throws(() => ollamaAdminCommand("9.9.9"), /pinned to 0\.34\.4/);
});

test("a mismatched Ollama installer is refused and not run", () => {
    const wrong = "a".repeat(64);
    let ran = false;
    const install = (actual) => {
        assertSha256Match(actual, OLLAMA_INSTALL_SHA256);
        ran = true;
    };
    assert.throws(() => install(wrong), new RegExp(`Ollama installer SHA-256 is ${wrong}, not the pinned ${PINNED}\\. The installer was not run\\.`));
    assert.equal(ran, false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-ollama-hash-"));
    const file = path.join(dir, "install.sh");
    fs.writeFileSync(file, "#!/bin/sh\necho no\n");
    assert.notEqual(fileSha256(file), PINNED);
    assert.throws(() => install(fileSha256(file)), /The installer was not run/);
    assert.equal(ran, false);
    assertSha256Match(PINNED, PINNED);
    fs.rmSync(dir, { recursive: true, force: true });
});

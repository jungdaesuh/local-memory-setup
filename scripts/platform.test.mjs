import assert from "node:assert/strict";
import test from "node:test";
import { binEntry, npmGlobalBin, npmGlobalBinDir, quoteWindowsArg, windowsCommandLine, xmlEscape } from "./platform.mjs";

test("npm global executables live in {prefix}/bin on Unix and directly in {prefix} on Windows", () => {
    assert.equal(npmGlobalBin("/home/a/.local", "qmd", "linux"), "/home/a/.local/bin/qmd");
    assert.equal(npmGlobalBin("/Users/a/.local", "qmd", "darwin"), "/Users/a/.local/bin/qmd");
    assert.equal(npmGlobalBin("C:\\Users\\a\\.local", "qmd", "win32"), "C:\\Users\\a\\.local\\qmd.cmd");
    assert.equal(npmGlobalBinDir("C:\\Users\\a\\.local", "win32"), "C:\\Users\\a\\.local");
    assert.equal(npmGlobalBinDir("/home/a/.local", "linux"), "/home/a/.local/bin");
});

test("cmd.exe command lines quote every argument and keep the outer pair for /s", () => {
    assert.equal(
        windowsCommandLine("C:\\Program Files\\nodejs\\node.exe", ["C:\\Users\\A B\\qmd", "mcp", "X-API-Key: ab12"]),
        '""C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\A B\\qmd" "mcp" "X-API-Key: ab12""',
    );
});

test("a trailing backslash is doubled so it does not escape the closing quote", () => {
    assert.equal(quoteWindowsArg("C:\\dir\\"), '"C:\\dir\\\\"');
    assert.equal(quoteWindowsArg("C:\\dir\\file"), '"C:\\dir\\file"');
});

test("arguments cmd.exe would expand or split are rejected, not mangled", () => {
    assert.throws(() => quoteWindowsArg('say "hi"'), /cmd\.exe/);
    assert.throws(() => quoteWindowsArg("%PATH%"), /cmd\.exe/);
    assert.throws(() => quoteWindowsArg("a\nb"), /cmd\.exe/);
});

test("binEntry reads string and map forms of package.json bin", () => {
    assert.equal(binEntry("bin/qmd", "qmd"), "bin/qmd");
    assert.equal(binEntry({ pnpm: "bin/pnpm.mjs", pnpx: "bin/pnpx.mjs" }, "pnpm"), "bin/pnpm.mjs");
    assert.throws(() => binEntry({ pnpx: "bin/pnpx.mjs" }, "pnpm"), /no bin entry named pnpm/);
    assert.throws(() => binEntry(undefined, "qmd"), /no bin entry/);
});

test("xmlEscape escapes the five XML specials", () => {
    assert.equal(xmlEscape(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

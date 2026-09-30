import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./backup_database.mjs", import.meta.url));
test("upgrade snapshots include a live WAL without modifying source rows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-backup-"));
    const source = path.join(root, "live.sqlite");
    const destination = path.join(root, "backup.sqlite");
    const database = new DatabaseSync(source);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE memories(content TEXT); INSERT INTO memories VALUES ('keep these bytes');");
    assert(fs.existsSync(`${source}-wal`));
    const result = spawnSync(process.execPath, [helper, source, destination], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const backup = new DatabaseSync(destination, { readOnly: true });
    assert.equal(backup.prepare("SELECT content FROM memories").get().content, "keep these bytes");
    assert.equal(database.prepare("SELECT content FROM memories").get().content, "keep these bytes");
    if (process.platform !== "win32") assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    backup.close();
    database.close();
    fs.rmSync(root, { recursive: true });
});

/** Consistent SQLite snapshot, including live WAL pages, before an upstream upgrade. */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Expected source and backup database paths.");
process.umask(0o077);
const database = new DatabaseSync(source, { readOnly: true });
try {
    database.prepare("VACUUM INTO ?").run(destination);
} finally {
    database.close();
}
if (process.platform !== "win32") fs.chmodSync(destination, 0o600);

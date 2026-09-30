/**
 * File reads and writes shared by detection and apply.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} file
 * @returns {string | null} contents, or null when the file does not exist
 */
export function readIfExists(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/**
 * Write a file the user owns (shell startup files, agent configs) when `content`
 * differs, in place, so a symlinked dotfile stays a symlink.
 * @param {string} file
 * @param {string} content
 * @returns {boolean} whether the file changed
 */
export function writeUserFile(file, content) {
    if (readIfExists(file) === content) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return true;
}

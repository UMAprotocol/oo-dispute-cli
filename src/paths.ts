import { isAbsolute, resolve } from "path";
import { existsSync } from "fs";

// The repository root (this file compiles to dist/paths.js). Default settings and state live under it, so the MCP
// server an agent starts and the `apply` a human runs share them whatever folder each was launched from.
export const REPO_ROOT = resolve(__dirname, "..");

export const repoPath = (...parts: string[]) => resolve(REPO_ROOT, ...parts);

// A relative path as written by the user: from the working folder if it exists there, else from the repository.
export function userPath(path: string): string {
    if (isAbsolute(path) || existsSync(path)) return resolve(path);
    return repoPath(path);
}

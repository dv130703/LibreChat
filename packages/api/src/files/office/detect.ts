import fs from 'fs/promises';
import path from 'path';

/** Extensions OfficeCLI produces that this integration turns into chat attachments. */
export const OFFICE_CLI_EXTENSIONS: readonly string[] = ['.docx', '.xlsx', '.pptx'];

export type FileMtimeSnapshot = Map<string, number>;

function isOfficeFile(fileName: string): boolean {
  return OFFICE_CLI_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

/**
 * Resolves `fileName` against `workspaceRoot` and throws if the result would
 * escape the workspace directory (via `../` traversal or an absolute path).
 * OfficeCLI has no documented `--root`/`--workspace` flag of its own, so this
 * is the application-level backstop on top of the OS-level sandbox (see the
 * `officecli` MCP server's wrapper script) against a tool call naming a file
 * outside the per-user workspace.
 */
export function resolveWorkspacePath(workspaceRoot: string, fileName: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, fileName);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path traversal detected: "${fileName}" resolves outside the workspace`);
  }
  return resolvedPath;
}

/**
 * Snapshots the mtimes of office-document files directly inside
 * `workspaceDir` (non-recursive — OfficeCLI's `create`/`batch`/`merge`
 * commands write named files into the current directory, not nested output
 * paths). A workspace that doesn't exist yet (no tool call has run for this
 * user) snapshots as empty rather than throwing.
 */
export async function snapshotOfficeFiles(workspaceDir: string): Promise<FileMtimeSnapshot> {
  const snapshot: FileMtimeSnapshot = new Map();
  let entries: string[];
  try {
    entries = await fs.readdir(workspaceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return snapshot;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!isOfficeFile(entry)) {
      continue;
    }
    try {
      const stats = await fs.stat(path.join(workspaceDir, entry));
      if (stats.isFile()) {
        snapshot.set(entry, stats.mtimeMs);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return snapshot;
}

/**
 * Diffs two snapshots and returns filenames that are new or whose mtime
 * advanced — i.e. the office files a tool call plausibly just wrote. This is
 * the detection mechanism for OfficeCLI's tool output: its MCP responses are
 * a generic `{success, data}` JSON envelope with no documented, reliable
 * "here is the output file path" field, so detection reads the filesystem
 * instead of trusting the tool call's return value.
 */
export function diffOfficeFiles(before: FileMtimeSnapshot, after: FileMtimeSnapshot): string[] {
  const changed: string[] = [];
  for (const [fileName, mtime] of after) {
    const previous = before.get(fileName);
    if (previous === undefined || mtime > previous) {
      changed.push(fileName);
    }
  }
  return changed;
}

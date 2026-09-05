import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { diffOfficeFiles, resolveWorkspacePath, snapshotOfficeFiles } from './detect';

describe('office/detect', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'officecli-detect-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  describe('resolveWorkspacePath', () => {
    it('resolves a plain relative filename inside the workspace', () => {
      const resolved = resolveWorkspacePath(workspaceDir, 'report.xlsx');
      expect(resolved).toBe(path.join(path.resolve(workspaceDir), 'report.xlsx'));
    });

    it('throws on a parent-directory traversal attempt', () => {
      expect(() => resolveWorkspacePath(workspaceDir, '../escape.xlsx')).toThrow(/path traversal/i);
    });

    it('throws on an absolute path outside the workspace', () => {
      expect(() => resolveWorkspacePath(workspaceDir, '/etc/passwd')).toThrow(/path traversal/i);
    });
  });

  describe('snapshotOfficeFiles + diffOfficeFiles', () => {
    it('returns an empty snapshot for a workspace that does not exist yet', async () => {
      const snapshot = await snapshotOfficeFiles(path.join(workspaceDir, 'missing'));
      expect(snapshot.size).toBe(0);
    });

    it('ignores non-office files', async () => {
      await fs.writeFile(path.join(workspaceDir, 'notes.txt'), 'hello');
      const snapshot = await snapshotOfficeFiles(workspaceDir);
      expect(snapshot.size).toBe(0);
    });

    it('detects a newly written office file across two snapshots', async () => {
      const before = await snapshotOfficeFiles(workspaceDir);
      await fs.writeFile(path.join(workspaceDir, 'report.xlsx'), 'fake-xlsx-bytes');
      const after = await snapshotOfficeFiles(workspaceDir);
      expect(diffOfficeFiles(before, after)).toEqual(['report.xlsx']);
    });

    it('detects a modified existing office file but not an untouched one', async () => {
      await fs.writeFile(path.join(workspaceDir, 'stable.docx'), 'v1');
      await fs.writeFile(path.join(workspaceDir, 'changing.docx'), 'v1');
      const before = await snapshotOfficeFiles(workspaceDir);

      // Ensure the mtime actually advances on filesystems with coarse mtime resolution.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fs.writeFile(path.join(workspaceDir, 'changing.docx'), 'v2');

      const after = await snapshotOfficeFiles(workspaceDir);
      expect(diffOfficeFiles(before, after)).toEqual(['changing.docx']);
    });
  });
});

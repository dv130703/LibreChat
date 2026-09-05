import type { AppConfig } from '@librechat/data-schemas';

const DEFAULT_FILE_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

type ExpiredFile = {
  file_id: string;
  source?: string;
  user?: string | { toString?: () => string };
  tenantId?: string;
};

type SweepRequest = {
  config?: AppConfig;
  user: {
    id: string;
    tenantId?: string;
  };
};

type SweepLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, error?: unknown) => void;
};

type SweepDependencies = {
  getExpiredFiles: (limit: number) => Promise<ExpiredFile[] | null | undefined>;
  processDeleteRequest: (params: {
    req: SweepRequest;
    files: ExpiredFile[];
  }) => Promise<{ deletedFileIds: string[]; failedFileIds: string[] }>;
  logger: SweepLogger;
};

type StartSweepDependencies = {
  sweepExpiredFiles: (options?: ExpiredFileSweepOptions) => Promise<ExpiredFileSweepResult>;
  runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: SweepLogger;
};

export type ExpiredFileSweepOptions = {
  appConfig?: AppConfig;
  limit?: number;
  loadAppConfig?: () => Promise<AppConfig | undefined>;
};

export type ExpiredFileSweepResult = {
  scanned: number;
  deleted: number;
  failed: number;
};

export function getFileRetentionSweepInterval(
  interval: string | undefined = process.env.FILE_RETENTION_SWEEP_INTERVAL_MS,
): number {
  if (interval == null || interval.trim() === '') {
    return DEFAULT_FILE_RETENTION_SWEEP_INTERVAL_MS;
  }

  const value = Number(interval);
  if (!Number.isFinite(value) || value < 0 || (value > 0 && value < 1)) {
    return DEFAULT_FILE_RETENTION_SWEEP_INTERVAL_MS;
  }
  return value;
}

export function createExpiredFileSweepRequest({
  appConfig,
  file,
  userId,
}: {
  appConfig?: AppConfig;
  file: ExpiredFile;
  userId: string;
}): SweepRequest {
  return {
    config: appConfig,
    user: {
      id: userId,
      tenantId: file.tenantId,
    },
  };
}

export async function sweepExpiredFiles(
  { appConfig, limit = 100 }: ExpiredFileSweepOptions | undefined = {},
  { getExpiredFiles, processDeleteRequest, logger }: SweepDependencies,
): Promise<ExpiredFileSweepResult> {
  const files = (await getExpiredFiles(limit)) ?? [];
  let deleted = 0;
  let failed = 0;

  for (const file of files) {
    const userId = typeof file.user === 'string' ? file.user : file.user?.toString?.();
    if (!userId) {
      logger.warn(`[sweepExpiredFiles] Skipping expired file without user: ${file.file_id}`);
      failed++;
      continue;
    }

    try {
      const req = createExpiredFileSweepRequest({ appConfig, file, userId });
      const { deletedFileIds, failedFileIds } = await processDeleteRequest({ req, files: [file] });
      if (failedFileIds.includes(file.file_id)) {
        failed++;
        continue;
      }

      if (deletedFileIds.includes(file.file_id)) {
        deleted++;
      } else {
        failed++;
        logger.error(
          `[sweepExpiredFiles] Delete request finished without resolving expired file ${file.file_id}`,
        );
      }
    } catch (error) {
      failed++;
      logger.error(`[sweepExpiredFiles] Error deleting expired file ${file.file_id}:`, error);
    }
  }

  if (deleted > 0 || failed > 0) {
    logger.info(
      `[sweepExpiredFiles] Processed ${files.length} expired files: ${deleted} deleted, ${failed} failed`,
    );
  }

  return { scanned: files.length, deleted, failed };
}

export function startExpiredFileSweep(
  options: ExpiredFileSweepOptions | undefined = {},
  { sweepExpiredFiles, runAsSystem, logger }: StartSweepDependencies,
): NodeJS.Timeout | null {
  const intervalMs = getFileRetentionSweepInterval();
  if (intervalMs === 0) {
    logger.info('[sweepExpiredFiles] Disabled by FILE_RETENTION_SWEEP_INTERVAL_MS=0');
    return null;
  }

  let isSweeping = false;
  const runSweep = async () => {
    if (isSweeping) {
      return;
    }

    isSweeping = true;
    try {
      await runAsSystem(() => sweepExpiredFiles(options));
    } catch (error) {
      logger.error('[sweepExpiredFiles] Background sweep failed:', error);
    } finally {
      isSweeping = false;
    }
  };

  runSweep();
  const interval = setInterval(runSweep, intervalMs);
  interval.unref?.();
  return interval;
}

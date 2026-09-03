const path = require('path');
const { logger, runAsSystem, tenantStorage } = require('@librechat/data-schemas');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { Conversation, File } = require('~/db/models');

/**
 * Cap on the number of per-conversation entries retained in `results.details`.
 * Larger runs still process every conversation and still report accurate
 * aggregate/per-tenant counts - this just keeps memory bounded on deployments
 * with many unresolved (pre-diarization-detail-file-era) conversations.
 */
const DETAIL_SAMPLE_LIMIT = 50;

/**
 * Marks every record this migration itself writes, so `--rollback` can undo
 * exactly those records and nothing else - in particular, never a
 * `transcription`/`sourceFileId` field the live routes wrote for a
 * conversation transcribed *after* this migration ran (see
 * `transcription/ARCHITECTURE.md` §4.4/R12).
 */
const MIGRATION_INSTANCE_ID = 'migration';

/**
 * Backfills the Audio Transcriber's per-recording job state from the
 * deprecated `Conversation.transcription` sub-document onto the *source
 * audio* File doc (`IFileTranscriptionJob`), and stamps each transcript
 * File doc with an explicit `sourceFileId` back-reference - see
 * `transcription/ARCHITECTURE.md` D3/D4/§4.4. Conversations transcribed
 * after Phase 1 landed already carry both fields (written live by
 * `api/server/routes/transcribe.js`) and are skipped here as
 * already-migrated.
 *
 * Idempotent - re-running only touches source files that don't already
 * have `transcription.status` set. Logs (rather than guesses at) any
 * conversation whose source file id can't be resolved.
 *
 * @param {{ dryRun?: boolean, batchSize?: number, tenant?: string, rollback?: boolean }} [options]
 *   `tenant` scopes the run to one tenant via `tenantStorage` (the
 *   tenant-isolation plugin then auto-filters every query); omitted, the
 *   run uses `runAsSystem` to scan across every tenant - matching
 *   `migrate-orphaned-agent-files.js`'s established convention for a
 *   cross-tenant remediation script.
 */
async function migrateTranscriptionToFile({
  dryRun = true,
  batchSize = 100,
  tenant,
  rollback = false,
} = {}) {
  await connect();

  logger.info('Starting Transcription-to-File Migration', { dryRun, batchSize, tenant, rollback });

  const runScoped = (fn) =>
    tenant ? tenantStorage.run({ tenantId: tenant }, fn) : runAsSystem(fn);

  return runScoped(
    rollback
      ? () => performRollback({ dryRun, batchSize })
      : () => performMigration({ dryRun, batchSize }),
  );
}

async function performMigration({ dryRun, batchSize }) {
  const totalConversations = await Conversation.countDocuments({
    transcription: { $exists: true },
  });
  logger.info(`Scanning ${totalConversations} transcribed conversation(s)`);

  const results = {
    dryRun,
    scannedConversations: 0,
    alreadyMigrated: 0,
    migrated: 0,
    unresolved: 0,
    errors: 0,
    perTenant: {},
    details: [],
  };

  const cursor = Conversation.find({ transcription: { $exists: true } })
    .lean()
    .cursor({ batchSize });

  for await (const convo of cursor) {
    results.scannedConversations++;
    const tenantBucket = convo.tenantId ?? '(no tenant)';
    results.perTenant[tenantBucket] ??= { scanned: 0, migrated: 0, unresolved: 0 };
    results.perTenant[tenantBucket].scanned++;

    try {
      const fileIds = convo.files ?? [];
      const transcriptFileId = fileIds.find((id) => id.endsWith('-transcript'));
      const diarizationDetailFileId = fileIds.find((id) => id.endsWith('-diarization-detail'));
      // Excludes both derived-file suffixes explicitly, same as the
      // /retranscribe route's own lookup - "whatever isn't the transcript"
      // would misidentify the diarization-detail file as the source.
      const sourceFileId = fileIds.find(
        (id) => id !== transcriptFileId && id !== diarizationDetailFileId,
      );

      if (!sourceFileId) {
        results.unresolved++;
        results.perTenant[tenantBucket].unresolved++;
        logger.warn(
          `[migrateTranscriptionToFile] No source file id found for conversation ${convo.conversationId}`,
        );
        if (results.details.length < DETAIL_SAMPLE_LIMIT) {
          results.details.push({
            conversationId: convo.conversationId,
            reason: 'no source file id found among conversation.files',
          });
        }
        continue;
      }

      const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
      if (!sourceFile) {
        results.unresolved++;
        results.perTenant[tenantBucket].unresolved++;
        logger.warn(
          `[migrateTranscriptionToFile] Source file record ${sourceFileId} not found ` +
            `for conversation ${convo.conversationId}`,
        );
        if (results.details.length < DETAIL_SAMPLE_LIMIT) {
          results.details.push({
            conversationId: convo.conversationId,
            sourceFileId,
            reason: 'source file record missing (deleted?)',
          });
        }
        continue;
      }

      if (sourceFile.transcription?.status) {
        results.alreadyMigrated++;
        continue;
      }

      if (dryRun) {
        results.migrated++;
        results.perTenant[tenantBucket].migrated++;
        continue;
      }

      const asOf = sourceFile.updatedAt ?? sourceFile.createdAt ?? new Date();
      await File.updateOne(
        { file_id: sourceFileId },
        {
          $set: {
            transcription: {
              status: 'ready',
              jobId: `migrated-${sourceFileId}`,
              instanceId: MIGRATION_INSTANCE_ID,
              heartbeatAt: asOf,
              startedAt: asOf,
              completedAt: asOf,
              // `requestedOptions` deliberately omitted: the original
              // request payload was never captured for historical
              // conversations, only the server-resolved values
              // (`Conversation.transcription`) survived - and per
              // `IFileTranscriptionJob.requestedOptions`'s own comment, an
              // empty object wouldn't survive Mongoose's `minimize` anyway,
              // so leaving the key out entirely is the honest
              // representation, not a workaround.
              effectiveOptions: convo.transcription,
              transcriptFileId,
              diarizationDetailFileId,
            },
          },
        },
      );

      if (transcriptFileId) {
        await File.updateOne(
          { file_id: transcriptFileId, sourceFileId: { $exists: false } },
          { $set: { sourceFileId } },
        );
      }

      results.migrated++;
      results.perTenant[tenantBucket].migrated++;
    } catch (error) {
      results.errors++;
      logger.error(
        `[migrateTranscriptionToFile] Failed to migrate conversation ${convo.conversationId}`,
        {
          error: error.message,
        },
      );
    }
  }

  logger.info('Transcription-to-File Migration completed', {
    dryRun,
    scannedConversations: results.scannedConversations,
    alreadyMigrated: results.alreadyMigrated,
    migrated: results.migrated,
    unresolved: results.unresolved,
    errors: results.errors,
    perTenant: results.perTenant,
  });

  return results;
}

/**
 * Undoes exactly what a non-dry-run migration wrote: clears `transcription`
 * from every source File doc this script itself stamped
 * (`transcription.instanceId === MIGRATION_INSTANCE_ID`), and clears
 * `sourceFileId` from the transcript files those source files pointed at.
 * Never touches a record the live routes wrote for a conversation
 * transcribed after this migration ran - those carry a real hostname as
 * `instanceId`, not the migration sentinel.
 */
async function performRollback({ dryRun, batchSize }) {
  const migratedSources = await File.find({ 'transcription.instanceId': MIGRATION_INSTANCE_ID })
    .lean()
    .cursor({ batchSize });

  const results = { dryRun, sourcesRolledBack: 0, transcriptsRolledBack: 0, errors: 0 };

  for await (const sourceFile of migratedSources) {
    try {
      if (!dryRun) {
        await File.updateOne({ file_id: sourceFile.file_id }, { $unset: { transcription: 1 } });
        if (sourceFile.transcription?.transcriptFileId) {
          await File.updateOne(
            { file_id: sourceFile.transcription.transcriptFileId },
            { $unset: { sourceFileId: 1 } },
          );
          results.transcriptsRolledBack++;
        }
      }
      results.sourcesRolledBack++;
    } catch (error) {
      results.errors++;
      logger.error(
        `[migrateTranscriptionToFile] Rollback failed for source file ${sourceFile.file_id}`,
        {
          error: error.message,
        },
      );
    }
  }

  logger.info('Transcription-to-File Migration rollback completed', results);
  return results;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const rollback = process.argv.includes('--rollback');
  const tenant = process.argv.find((arg) => arg.startsWith('--tenant='))?.split('=')[1];
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;

  migrateTranscriptionToFile({ dryRun, batchSize, tenant, rollback })
    .then((result) => {
      console.log(`\n=== ${dryRun ? 'DRY RUN ' : ''}${rollback ? 'ROLLBACK ' : ''}RESULTS ===`);
      if (rollback) {
        console.log(`Source files rolled back: ${result.sourcesRolledBack}`);
        console.log(`Transcript files rolled back: ${result.transcriptsRolledBack}`);
      } else {
        console.log(`Conversations scanned: ${result.scannedConversations}`);
        console.log(`Already migrated: ${result.alreadyMigrated}`);
        console.log(`Migrated${dryRun ? ' (would be)' : ''}: ${result.migrated}`);
        console.log(`Unresolved: ${result.unresolved}`);
        if (Object.keys(result.perTenant).length > 1) {
          console.log('\nPer-tenant breakdown:');
          for (const [tenantId, counts] of Object.entries(result.perTenant)) {
            console.log(
              `  ${tenantId}: scanned=${counts.scanned} migrated=${counts.migrated} unresolved=${counts.unresolved}`,
            );
          }
        }
        if (result.details.length > 0) {
          console.log('\nUnresolved conversations:');
          result.details.forEach((d, i) => {
            console.log(`  ${i + 1}. ${d.conversationId} — ${d.reason}`);
          });
        }
      }
      if (result.errors > 0) {
        console.log(`Errors: ${result.errors}`);
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('Transcription-to-file migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateTranscriptionToFile };

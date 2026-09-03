import { useMemo, useState, useCallback, memo } from 'react';
import type { TFile, TMessage } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { useTranscribeStatusQuery } from '~/data-provider';
import { isAudioOrVideoMimeType } from '~/utils';
import TranscriptCard from './Parts/TranscriptCard';
import FilePreviewDialog from './FilePreviewDialog';
import Image from './Image';

const Files = ({ message }: { message?: TMessage }) => {
  const imageFiles = useMemo(() => {
    return message?.files?.filter((file) => file.type?.startsWith('image/')) || [];
  }, [message?.files]);

  const audioVideoFiles = useMemo(() => {
    return message?.files?.filter((file) => isAudioOrVideoMimeType(file.type)) || [];
  }, [message?.files]);

  const audioVideoFileIds = useMemo(
    () => audioVideoFiles.map((file) => file.file_id ?? '').filter(Boolean),
    [audioVideoFiles],
  );
  /** One batched poll for every audio/video file this message has, rather
   *  than one per `TranscriptCard` - `useTranscribeStatusQuery`'s cache key
   *  includes the full id list, so per-card queries wouldn't dedupe against
   *  this one anyway. A source file with no entry here was attached as a
   *  plain file (declined transcription, or the endpoint accepted it
   *  natively) - see transcription/ARCHITECTURE.md §6.1/§6.4. */
  const { data: transcribeStatusData } = useTranscribeStatusQuery(audioVideoFileIds);

  /** Audio/video attached via composer transcription - rendered as a
   *  status-polling `TranscriptCard` instead of the plain `FileContainer`
   *  every other non-image file gets. Until the status poll above resolves,
   *  treated as "not a transcription job" (falls through to `FileContainer`)
   *  rather than flashing a spinner for files that never were one - it
   *  self-corrects to `TranscriptCard` within one round trip for files that
   *  actually are. */
  const transcribableFiles = useMemo(() => {
    if (!transcribeStatusData) {
      return [];
    }
    const jobFileIds = new Set(transcribeStatusData.files.map((entry) => entry.file_id));
    return audioVideoFiles.filter((file) => jobFileIds.has(file.file_id ?? ''));
  }, [audioVideoFiles, transcribeStatusData]);

  const otherFiles = useMemo(() => {
    const transcribableIds = new Set(transcribableFiles.map((file) => file.file_id));
    return (
      message?.files?.filter(
        (file) => !file.type?.startsWith('image/') && !transcribableIds.has(file.file_id),
      ) || []
    );
  }, [message?.files, transcribableFiles]);

  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  return (
    <>
      {transcribableFiles.length > 0 &&
        transcribableFiles.map((file) => (
          <TranscriptCard
            key={file.file_id}
            file={file}
            jobStatus={transcribeStatusData?.files.find((entry) => entry.file_id === file.file_id)}
          />
        ))}
      {otherFiles.length > 0 &&
        otherFiles.map((file) => (
          <FileContainer
            key={file.file_id}
            file={file as TFile}
            onClick={() => setSelectedFile(file)}
          />
        ))}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <Image
            key={file.file_id}
            imagePath={file.preview ?? file.filepath ?? ''}
            height={file.height ?? 1920}
            width={file.width ?? 1080}
            altText={file.filename ?? 'Uploaded Image'}
          />
        ))}
      <FilePreviewDialog
        open={selectedFile !== null}
        onOpenChange={handleClose}
        fileName={selectedFile?.filename ?? ''}
        fileId={selectedFile?.file_id}
        filePath={selectedFile?.filepath}
        fileType={selectedFile?.type ?? undefined}
        fileSize={(selectedFile as TFile)?.bytes}
      />
    </>
  );
};

export default memo(Files);

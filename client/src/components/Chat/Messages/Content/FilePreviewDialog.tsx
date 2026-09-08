import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import copy from 'copy-to-clipboard';
import { useRecoilValue } from 'recoil';
import { Download } from 'lucide-react';
import { OGDialog, OGDialogContent, OGDialogTitle, OGDialogDescription } from '@librechat/client';
import { useFileDownload, useSharedFileDownload } from '~/data-provider';
import { logger, sortPagesByRelevance, triggerDownload, findPassage } from '~/utils';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useShareContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface FilePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  fileId?: string;
  filePath?: string;
  relevance?: number;
  pages?: number[];
  pageRelevance?: Record<number, number>;
  fileType?: string;
  fileSize?: number;
  /** The exact retrieved chunk text this preview was opened for (a citation
   *  click, or the file_search tool call's own "view source" button) - used
   *  to scroll to and highlight the passage in a text preview, and to show
   *  the passage as a labelled excerpt alongside a PDF preview, which has no
   *  scripting access into the browser's native PDF renderer to highlight
   *  inside. */
  highlightText?: string;
}

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function canPreviewByMime(mime?: string): 'pdf' | 'text' | false {
  if (!mime) {
    return false;
  }
  if (mime.includes('pdf')) {
    return 'pdf';
  }
  if (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('javascript') ||
    mime.includes('typescript') ||
    mime.includes('yaml') ||
    mime.includes('csv')
  ) {
    return 'text';
  }
  return false;
}

function canPreviewByExt(filename: string): 'pdf' | 'text' | false {
  const ext = getFileExtension(filename);
  if (ext === 'pdf') {
    return 'pdf';
  }
  const textExts = new Set([
    'txt',
    'md',
    'csv',
    'json',
    'xml',
    'yaml',
    'yml',
    'html',
    'css',
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'rb',
    'java',
    'c',
    'cpp',
    'h',
    'go',
    'rs',
    'sh',
    'sql',
    'log',
  ]);
  return textExts.has(ext) ? 'text' : false;
}

/** Formats bytes with unit suffix (differs from ~/utils/formatBytes which returns a raw number). */
function formatBytes(bytes: number): string {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function getDisplayType(fileType?: string, fileName?: string): string {
  if (fileType) {
    if (fileType.includes('pdf')) {
      return 'PDF';
    }
    if (fileType.includes('word') || fileType.includes('document')) {
      return 'Document';
    }
    if (fileType.includes('spreadsheet') || fileType.includes('excel')) {
      return 'Spreadsheet';
    }
    if (fileType.includes('presentation') || fileType.includes('powerpoint')) {
      return 'Presentation';
    }
    if (fileType.includes('image')) {
      return 'Image';
    }
    if (fileType.startsWith('text/')) {
      return fileType.split('/')[1]?.toUpperCase() || 'Text';
    }
    if (fileType.includes('json')) {
      return 'JSON';
    }
    if (fileType.includes('xml')) {
      return 'XML';
    }
  }
  const ext = fileName ? getFileExtension(fileName) : '';
  return ext ? ext.toUpperCase() : 'File';
}

export default function FilePreviewDialog({
  open,
  onOpenChange,
  fileName,
  fileId,
  filePath,
  relevance,
  pages,
  pageRelevance,
  fileType,
  fileSize,
  highlightText,
}: FilePreviewDialogProps) {
  const localize = useLocalize();
  const user = useRecoilValue(store.user);
  const { shareId } = useShareContext();
  const { refetch: downloadOwned } = useFileDownload(user?.id ?? '', fileId, { direct: false });
  const { refetch: downloadShared } = useSharedFileDownload(shareId, fileId);
  // Use the share route only for snapshotted files (filepath rewritten to the
  // share path); otherwise fall back to the owner route.
  const useShared = !!shareId && (filePath?.startsWith('/api/share/') ?? false);
  const downloadFile = useShared ? downloadShared : downloadOwned;

  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileBlobUrl, setFileBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const loadingRef = useRef(false);
  const highlightRef = useRef<HTMLElement | null>(null);

  const previewKind = canPreviewByMime(fileType) || canPreviewByExt(fileName);

  const cancelledRef = useRef(false);

  const loadPreview = useCallback(async () => {
    if (!fileId || !previewKind || loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    cancelledRef.current = false;
    setLoading(true);
    setPreviewError(false);

    try {
      const result = await downloadFile();
      if (cancelledRef.current || !result.data) {
        if (!cancelledRef.current) {
          setPreviewError(true);
        }
        return;
      }

      const resp = await fetch(result.data);
      const blob = await resp.blob();

      if (cancelledRef.current) {
        return;
      }

      if (previewKind === 'text') {
        setFileContent(await blob.text());
      } else {
        const typed = new Blob([blob], { type: 'application/pdf' });
        setFileBlobUrl(URL.createObjectURL(typed));
      }
    } catch {
      if (!cancelledRef.current) {
        setPreviewError(true);
      }
    } finally {
      loadingRef.current = false;
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [fileId, previewKind, downloadFile]);

  const handleDownload = useCallback(async () => {
    if (!fileId) {
      return;
    }
    try {
      const result = await downloadFile();
      if (!result.data) {
        return;
      }
      triggerDownload(result.data, fileName);
    } catch (err) {
      logger.error('[FilePreviewDialog] Download failed:', err);
    }
  }, [downloadFile, fileId, fileName]);

  useEffect(() => {
    if (open && previewKind && !fileContent && !fileBlobUrl) {
      loadPreview();
    }
  }, [open, previewKind, fileContent, fileBlobUrl, loadPreview]);

  useEffect(() => {
    return () => {
      if (fileBlobUrl) {
        URL.revokeObjectURL(fileBlobUrl);
      }
    };
  }, [fileBlobUrl]);

  useEffect(() => {
    if (!open) {
      cancelledRef.current = true;
      setFileContent(null);
      setFileBlobUrl(null);
      setPreviewError(false);
      setLoading(false);
      setIsCopied(false);
    }
  }, [open]);

  const handleCopy = useCallback(() => {
    if (!fileContent) {
      return;
    }
    copy(fileContent, { format: 'text/plain' });
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 3000);
  }, [fileContent]);

  const displayType = useMemo(() => getDisplayType(fileType, fileName), [fileType, fileName]);
  const sortedPages = useMemo(
    () => (pages && pageRelevance ? sortPagesByRelevance(pages, pageRelevance) : pages),
    [pages, pageRelevance],
  );

  // Only meaningful for the text-preview path - `fileContent` is null for a
  // PDF, so this is a no-op there (the PDF path shows `highlightText` as its
  // own excerpt block instead, further down).
  const passageMatch = useMemo(
    () => (fileContent && highlightText ? findPassage(fileContent, highlightText) : null),
    [fileContent, highlightText],
  );

  // Native PDF viewers (Chromium's PDFium, Firefox's pdf.js) honor the
  // `#page=N` fragment as an "open at this page" instruction - the one thing
  // scriptable about an iframe pointed at a blob URL, since there is no API
  // into the viewer itself to scroll or highlight beyond that. Falls back to
  // the plain blob URL when no page is known, rather than fabricating one.
  const pdfSrc = useMemo(() => {
    if (!fileBlobUrl) {
      return null;
    }
    const page = sortedPages?.[0];
    return page ? `${fileBlobUrl}#page=${page}` : fileBlobUrl;
  }, [fileBlobUrl, sortedPages]);

  // Runs once per successful match, not on every render - `highlightRef`
  // itself can't be a dependency (refs don't trigger re-renders), so this
  // keys off the match's own boundaries instead, which only change when a
  // genuinely different passage is found.
  useEffect(() => {
    if (!passageMatch) {
      return;
    }
    highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [passageMatch?.start, passageMatch?.end]);

  const metaParts: string[] = [displayType];
  if (relevance != null && relevance > 0) {
    metaParts.push(`${localize('com_ui_relevance')}: ${Math.round(relevance * 100)}%`);
  }
  if (fileSize != null && fileSize > 0) {
    metaParts.push(formatBytes(fileSize));
  }
  if (sortedPages && sortedPages.length > 0) {
    metaParts.push(localize('com_file_pages', { pages: sortedPages.join(', ') }));
  }

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        className="flex w-full max-w-4xl flex-col !overflow-hidden p-0"
        showCloseButton={true}
      >
        <div className="shrink-0 px-6 pr-12 pt-6">
          <OGDialogTitle className="truncate text-base">{fileName}</OGDialogTitle>
          <div className="mt-0.5 flex items-center gap-3">
            <OGDialogDescription className="min-w-0 truncate">
              {metaParts.join(' · ')}
            </OGDialogDescription>
            {fileId && (
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex shrink-0 items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
                aria-label={`${localize('com_ui_download')} ${fileName}`}
              >
                <Download className="size-3" aria-hidden="true" />
                {localize('com_ui_download')}
              </button>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
          {loading && (
            <div className="flex h-60 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="shimmer text-sm text-text-secondary">
                {localize('com_ui_loading')}
              </span>
            </div>
          )}
          {previewError && (
            <div className="flex h-32 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="text-sm text-text-secondary">
                {localize('com_ui_preview_unavailable')}
              </span>
            </div>
          )}
          {fileBlobUrl && (
            <>
              {/* The rendered PDF itself can't be highlighted - a raw
                  iframe into the browser's native viewer has no scripting
                  surface beyond the `#page=N` fragment already applied to
                  `pdfSrc`. Showing the exact retrieved text here is the
                  substitute: the passage the model actually cited, even
                  though it isn't highlighted in place. */}
              {highlightText && (
                <div className="mb-3 rounded-lg border border-border-medium bg-surface-secondary p-3">
                  <div className="mb-1 text-xs font-medium text-text-secondary">
                    {localize('com_ui_retrieved_passage')}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
                    {highlightText}
                  </p>
                </div>
              )}
              <iframe
                src={pdfSrc ?? undefined}
                title={`${localize('com_ui_preview')}: ${fileName}`}
                className="h-[70vh] w-full rounded-lg border border-border-light"
              />
            </>
          )}
          {fileContent && (
            <>
              <div className="pointer-events-none sticky top-0 z-10 flex justify-end pr-1">
                <CopyButton
                  isCopied={isCopied}
                  onClick={handleCopy}
                  iconOnly
                  label={localize('com_ui_copy')}
                  className="pointer-events-auto rounded-lg bg-surface-secondary"
                />
              </div>
              <div className="-mt-8 rounded-lg bg-surface-secondary p-4">
                <pre className="whitespace-pre-wrap break-words pr-8 font-mono text-sm leading-6 text-text-primary">
                  {passageMatch ? (
                    <>
                      {fileContent.slice(0, passageMatch.start)}
                      <mark
                        ref={highlightRef}
                        className="rounded bg-yellow-200 text-text-primary dark:bg-yellow-500/40"
                      >
                        {fileContent.slice(passageMatch.start, passageMatch.end)}
                      </mark>
                      {fileContent.slice(passageMatch.end)}
                    </>
                  ) : (
                    fileContent
                  )}
                </pre>
              </div>
            </>
          )}
          {!previewKind && !loading && (
            <div className="flex h-32 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="text-sm text-text-secondary">
                {localize('com_ui_preview_unavailable')}
              </span>
            </div>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

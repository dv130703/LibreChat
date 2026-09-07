/**
 * The class strings that define a message row's inner shell, in one place.
 *
 * `MessageRender` renders these two wrappers nested, and anything that has to
 * sit where a message will sit - today the audio transcriber's pending-upload
 * placeholder - has to match them exactly or it reads as a different kind of
 * object in the thread. It previously hand-copied them and merged the two
 * into one, which silently dropped `items-start`: without it the flex column
 * stretches its child to full width, so the placeholder's chip rendered
 * inside a full-width box while the real message's chip hugged its content.
 * Importing the same constants makes that class of drift impossible rather
 * than merely discouraged.
 */

/** The message body: everything below the header, above the action row. */
export const MESSAGE_BODY_CLASSES = 'flex min-h-[20px] max-w-full flex-grow flex-col gap-0';

/** The content wrapper inside the body. `items-start` is load-bearing - it is
 *  what makes an attachment chip size to its content instead of stretching. */
export const MESSAGE_CONTENT_CLASSES =
  'text-message flex min-h-[20px] flex-col items-start gap-3 overflow-visible';

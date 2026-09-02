"""Log formatting for this process.

This process hosts two unrelated services - the vector store and the
transcription pipeline - so a single process-level label is always wrong for
half its output. The emitter names itself instead: every line carries the
concern it came from, derived from the logger's own module path.

Third-party loggers keep their own top-level name (``whisperx``, ``pyannote``,
``uvicorn``), which is more useful than folding them into whichever of our
services happened to call them.
"""

import logging

# Our own modules, mapped to the concern they belong to. Anything unlisted
# keeps its own root name, which is what makes library output self-describing.
_CONCERNS = {
    "transcription": "transcription",
    "rag_server": "rag",
    "db": "rag",
    "extract": "rag",
    "guidance": "rag",
    "config": "rag",
    "auth": "auth",
    "net_diagnostics": "network",
    # Request logging spans every route this process serves, so it is its own
    # concern - tagging it with either service would be wrong for the other.
    "http": "http",
}

# Concern first, not the timestamp: the first thing you need from a line in a
# three-process dev terminal is where it came from, and a leading timestamp
# buries that behind 23 identical characters on every line. Padded so messages
# align into a column instead of ragging with the tag width.
LOG_FORMAT = "%(concern_tag)s %(asctime)s [%(levelname)s] %(message)s"
_TAG_WIDTH = 15


class ConcernFilter(logging.Filter):
    """Adds `%(concern)s` to every record, from the logger's root package."""

    def filter(self, record: logging.LogRecord) -> bool:
        root = record.name.split(".")[0]
        concern = _CONCERNS.get(root, root)
        record.concern = concern
        record.concern_tag = f"[{concern}]".ljust(_TAG_WIDTH)
        return True


def configure(level: int = logging.INFO) -> None:
    """Install the concern-tagged format on the root logger.

    ``force`` matters: whisperx and pyannote configure logging at import time,
    which is before this runs, and without it their handlers stay in place and
    emit in a second, different format alongside ours.
    """
    logging.basicConfig(level=level, format=LOG_FORMAT, force=True)
    concern_filter = ConcernFilter()
    for handler in logging.getLogger().handlers:
        handler.addFilter(concern_filter)

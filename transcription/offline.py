import logging
import os
import socket
import threading
from dataclasses import dataclass
from time import monotonic
from urllib.parse import urlparse

import huggingface_hub
import transformers.utils.hub as transformers_hub
from huggingface_hub.utils import reset_sessions

from .config import Settings

logger = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "https://huggingface.co"
# HF_HUB_OFFLINE is the one huggingface_hub itself reads; the other two are read
# by transformers and datasets, which are pulled in by the alignment stage.
OFFLINE_ENV_VARS = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE")
# How long a reachability verdict is reused. One transcription loads three models
# in a row and must not pay for three probes; a minute is also short enough that
# plugging the network back in is picked up by the next recording.
PROBE_TTL_S = 60.0
# How long an *inconclusive* verdict is reused. A probe that ran out of time told
# us nothing except that it was slow, and it is still running - so re-ask it
# almost immediately rather than sitting on a guess for a full minute.
INCONCLUSIVE_TTL_S = 5.0

_lock = threading.Lock()
_offline: bool | None = None
_probed_at = 0.0
_probe_conclusive = True
_applied: bool | None = None
_pending_probe: threading.Thread | None = None
_pending_result: list["Probe"] = []

# Read once, before anything here has written to it, so it is still the operator's
# own HF_HUB_OFFLINE and not this module's echo of a probe. A deployment that set
# it deliberately means it, and "auto" must not talk it back out of offline the
# moment a network appears.
ENV_FORCED_OFFLINE = huggingface_hub.constants.HF_HUB_OFFLINE


def _hub_address() -> tuple[str, int]:
    endpoint = os.environ.get("HF_ENDPOINT") or DEFAULT_ENDPOINT
    parsed = urlparse(endpoint)
    return parsed.hostname or "huggingface.co", parsed.port or (80 if parsed.scheme == "http" else 443)


@dataclass(frozen=True)
class Probe:
    reachable: bool
    detail: str
    # Which endpoint this verdict is about, and when it landed. A result handed
    # over by a thread that outlived its deadline is only usable if it answers
    # the question being asked now - HF_ENDPOINT can be repointed, and a verdict
    # that finished long enough ago is describing a different network.
    address: str = ""
    at: float = 0.0
    # False when the probe ran out of time rather than answering. "Slow" and
    # "absent" are different networks, and only the second one is a fact.
    conclusive: bool = True

    def is_usable_for(self, address: str) -> bool:
        return self.address == address and monotonic() - self.at < PROBE_TTL_S


def can_reach_hub(timeout: float) -> Probe:
    """Whether the Hugging Face endpoint answers a TCP connect within `timeout`.

    Run on a daemon thread rather than inline: the socket timeout covers the
    connect but not the getaddrinfo before it, and a name lookup against an
    unreachable resolver blocks for the resolver's own timeout - the multi-second
    stall this whole module exists to avoid.

    A thread that outlives its deadline is kept rather than abandoned. It is
    already doing the work, and by the next call it has usually finished, so the
    following probe reads a real answer instead of guessing again. Without that,
    a network that merely resolves slowly would be re-declared absent every
    single time, and nothing would ever download again.

    Callers must hold `_lock`.
    """
    global _pending_probe

    host, port = _hub_address()
    address = f"{host}:{port}"

    def take_result() -> Probe | None:
        global _pending_probe
        while _pending_result:
            finished = _pending_result.pop()
            if finished.is_usable_for(address):
                _pending_probe = None
                return finished
        return None

    if _pending_probe is not None and not _pending_probe.is_alive():
        _pending_probe = None
        settled = take_result()
        if settled is not None:
            return settled

    if _pending_probe is not None:
        thread = _pending_probe
    else:
        _pending_result.clear()

        def probe() -> None:
            try:
                with socket.create_connection((host, port), timeout=timeout):
                    _pending_result.append(Probe(True, f"{address} answered", address, monotonic()))
            except OSError as error:
                _pending_result.append(
                    Probe(False, f"{address} did not answer: {error}", address, monotonic())
                )

        thread = threading.Thread(target=probe, name="hf-hub-probe", daemon=True)
        thread.start()

    thread.join(timeout)

    settled = take_result()
    if settled is not None:
        return settled

    _pending_probe = thread
    return Probe(False, f"no answer within {timeout:g}s", address, monotonic(), conclusive=False)


def _apply(offline: bool) -> None:
    """Switch every model loader in the process between cache-only and normal.

    Setting the environment variables is not enough on its own, and neither is
    setting them before the imports:

    - transformers snapshots HF_HUB_OFFLINE into a module global at import time
      (transformers/utils/hub.py), so the variable is read long before a probe
      could run.
    - huggingface_hub mounts its offline adapter when a session is constructed,
      and caches one session per thread, so sessions built under the old verdict
      keep the old behaviour until the cache is dropped.

    The environment variables are still set, for libraries imported later.
    """
    global _applied
    if _applied == offline:
        return

    value = "1" if offline else "0"
    for name in OFFLINE_ENV_VARS:
        os.environ[name] = value

    huggingface_hub.constants.HF_HUB_OFFLINE = offline
    transformers_hub._is_offline_mode = offline
    reset_sessions()
    _applied = offline


def ensure_offline_mode(settings: Settings) -> bool:
    """Resolve and apply offline mode, returning whether loaders are cache-only.

    Called before every model load rather than once at startup, because the
    verdict is a property of the network at that moment, not of the process.

    Nothing here decides whether a model *can* load - every model still comes
    from the same cache either way. It only decides whether the loaders are
    allowed to ask the network first, which with no network costs a DNS timeout
    per file: several minutes across the whisper, alignment and pyannote
    checkpoints, all of it spent to arrive at the cached file it started with.
    """
    global _offline, _probed_at, _probe_conclusive

    mode = settings.offline_mode.strip().lower()

    if settings.local_files_only or mode == "on" or ENV_FORCED_OFFLINE:
        _apply(True)
        return True

    if mode == "off":
        _apply(False)
        return False

    if mode != "auto":
        logger.warning(
            "Unknown WHISPERX_OFFLINE_MODE=%r; expected auto/on/off. Falling back to auto.",
            settings.offline_mode,
        )

    with _lock:
        ttl = PROBE_TTL_S if _probe_conclusive else INCONCLUSIVE_TTL_S
        if _offline is None or monotonic() - _probed_at >= ttl:
            probe = can_reach_hub(settings.hub_probe_timeout_s)
            if _offline != (not probe.reachable) or not probe.conclusive:
                logger.info(
                    "Hugging Face endpoint %s (%s); loading models %s",
                    "reachable" if probe.reachable else "unreachable",
                    probe.detail,
                    "normally" if probe.reachable else "from the local cache only",
                )
            _offline = not probe.reachable
            _probe_conclusive = probe.conclusive
            _probed_at = monotonic()
        offline = _offline

    _apply(offline)
    return offline

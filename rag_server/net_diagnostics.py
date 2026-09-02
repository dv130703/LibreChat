"""Logs every outbound TCP connection this process makes to a non-local
address, with the call stack that triggered it.

Exists to answer one question quickly: when outgoing network access is
locked down (e.g. a firewall's default-outgoing policy switched to deny),
which library is actually reaching out, to where, from which line of code -
without needing root to read firewall logs. Install this before importing
anything else (see `app.py`), since some libraries make their own connection
attempts at import time, not just when a route handler runs.

Logging only, never blocking - a connection this doesn't recognize as local
still proceeds exactly as it would have; this module can only make the
reason for a later firewall block legible, not change whether one happens.
"""

import ipaddress
import logging
import socket
import traceback

logger = logging.getLogger(__name__)

_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex

# This module's own frames must never appear in the "called from" trace - the
# interesting caller is whoever's *using* the socket, not this wrapper.
_THIS_FILE = __file__


def _is_local(host: str) -> bool:
    if host in ("localhost",):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        # A hostname, not a literal IP - can't tell without resolving it, and
        # resolving it here would itself be a DNS lookup this module has no
        # business making. Treated as non-local: better a hostname logged
        # once too often than a real outbound destination missed.
        return False


def _describe_caller() -> str:
    frames = [
        frame
        for frame in traceback.extract_stack()[:-2]
        if frame.filename != _THIS_FILE
    ]
    tail = frames[-4:]
    return " -> ".join(f"{f.filename.split('/')[-1]}:{f.lineno} in {f.name}" for f in tail)


def _log_attempt(address) -> None:
    if not isinstance(address, tuple) or len(address) < 2:
        return
    host, port = address[0], address[1]
    if _is_local(str(host)):
        return
    logger.warning(
        "outbound connect -> %s:%s | called from: %s",
        host,
        port,
        _describe_caller(),
    )


def _patched_connect(self, address):
    _log_attempt(address)
    return _real_connect(self, address)


def _patched_connect_ex(self, address):
    _log_attempt(address)
    return _real_connect_ex(self, address)


_installed = False


def install() -> None:
    """Idempotent - safe to call more than once (module re-import, reload)."""
    global _installed
    if _installed:
        return
    socket.socket.connect = _patched_connect
    socket.socket.connect_ex = _patched_connect_ex
    _installed = True
    logger.info("Outbound-connection logging installed - every non-local connect() will be logged before it happens.")

"""Builds Whisper's ``initial_prompt`` and budgets it against the real decoder
context.

Whisper is not instruction-tuned. It treats this text as *the transcript that
came just before*, so it biases spelling, casing and vocabulary - and nothing
else. Prose about the recording ("this is a formal meeting concerning...") buys
almost nothing here and is the part most likely to be echoed verbatim into the
output over a silent stretch, so this module emits terms only, never framing.

The budget
----------
``WhisperModel.max_length`` is 448, and that is the budget for the *whole*
generation - prompt tokens and emitted tokens share it. faster-whisper then caps
each prompt part at ``448 // 2 - 1 = 223`` (``transcribe.py:1546``, ``:1550``),
and ``hotwords`` and the initial prompt are separate parts that stack, so a full
pair would consume ~446 tokens and leave the decoder no room to write anything.

So the ceiling here is not "223 for us": it is what remains after the
deployment-wide glossary has taken its share and enough has been reserved for
30 seconds of speech to actually be transcribed. See ``prompt_budget``.

Counting is exact when a tokenizer is supplied (the service has one once the
model is loaded), because a pessimistic character heuristic leaves a third of
the window unused - and unused window is terms the user typed that never
reached the model. The heuristic remains as a fallback for callers with no model
to hand.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

TokenCounter = Callable[[str], int]

# faster_whisper.transcribe.WhisperModel.max_length - the combined prompt +
# output budget for one 30s window.
DECODER_CONTEXT_TOKENS = 448

# Per-part cap faster-whisper applies to hotwords and to the prompt separately.
FASTER_WHISPER_PART_CAP = DECODER_CONTEXT_TOKENS // 2 - 1  # 223

# sot_prev + sot_sequence + no_timestamps, with slack. Small and fixed.
PROMPT_STRUCTURE_TOKENS = 6

# Reserved so the decoder can actually emit a chunk. 30s of brisk speech is
# ~75 words / ~110 tokens; 200 leaves room for dense or non-English audio
# without ever letting the prompt crowd out the transcript.
DEFAULT_OUTPUT_HEADROOM_TOKENS = 200

# Used only when no tokenizer is available. Deliberately pessimistic - names and
# acronyms fragment far worse than prose.
_CHARS_PER_TOKEN = 3

# One term should be a name or a phrase, not a pasted sentence.
_MAX_TERM_CHARS = 60
_MAX_TERMS = 256

_SEPARATORS = re.compile(r"[,;\n\r]+")
_WHITESPACE = re.compile(r"\s+")

# Harvesting candidates out of the prose context: bare acronyms, and runs of
# *adjacent* capitalised words. Deliberately precision-first, because a bad
# guess costs prompt budget a real term needed and can seed the transcript with
# a word nobody said. Two consequences, both accepted:
#   - lone capitalised words are ignored, since most are sentence openings;
#   - names bridged by a lowercase connector ("Bank of England") are missed,
#     because allowing the connector also matches "Reviewed the London".
# Anything the harvester misses can still be typed into the terms field, which
# is packed first and always wins.
_ACRONYM = re.compile(r"\b[A-Z][A-Z0-9]{1,7}\b")
_CAPITALISED_RUN = re.compile(r"\b[A-Z][a-z’'\-]+(?:\s+[A-Z][a-z’'\-]+)+")

# Openers that begin a sentence far more often than they begin a name.
_HARVEST_STOPWORDS = frozenset(
    {"a", "an", "the", "this", "that", "these", "those", "it", "we", "they", "he", "she",
     "i", "there", "here", "his", "her", "their", "our", "in", "on", "at", "for", "with",
     "and", "but", "or", "if", "when", "while", "during", "after", "before", "subject",
     "interview", "recording", "meeting", "conducted", "regarding", "about"}
)


@dataclass
class PromptBuild:
    """The prompt, plus an account of what went into it and what did not."""

    prompt: str | None
    used_terms: list[str] = field(default_factory=list)
    dropped_terms: list[str] = field(default_factory=list)
    harvested_terms: list[str] = field(default_factory=list)
    budget_tokens: int = 0
    used_tokens: int = 0

    @property
    def is_empty(self) -> bool:
        return not self.prompt


def estimate_tokens(text: str) -> int:
    """Fallback counter for callers with no tokenizer."""
    return -(-len(text) // _CHARS_PER_TOKEN)  # ceil division


def prompt_budget(
    hotwords_tokens: int = 0,
    output_headroom: int = DEFAULT_OUTPUT_HEADROOM_TOKENS,
) -> int:
    """How many tokens the initial prompt may spend.

    Whatever is left of the decoder context once the deployment glossary and the
    reserved output headroom are taken out, and never more than the per-part cap
    faster-whisper enforces anyway.
    """
    remaining = DECODER_CONTEXT_TOKENS - output_headroom - PROMPT_STRUCTURE_TOKENS - hotwords_tokens
    return max(0, min(remaining, FASTER_WHISPER_PART_CAP))


def parse_terms(raw: str | None) -> list[str]:
    """Split user input into clean terms, in the order given.

    Commas, semicolons and newlines all separate. Duplicates are dropped
    case-insensitively, keeping the first spelling seen - which is the one the
    user typed most deliberately, and the one Whisper should copy.
    """
    if not raw:
        return []

    seen: dict[str, str] = {}
    for chunk in _SEPARATORS.split(raw):
        term = _WHITESPACE.sub(" ", chunk).strip()
        if not term or len(term) > _MAX_TERM_CHARS:
            continue
        seen.setdefault(term.casefold(), term)
        if len(seen) >= _MAX_TERMS:
            break
    return list(seen.values())


def harvest_terms(prose: str | None) -> list[str]:
    """Pull likely proper nouns out of the free-text context.

    The prose itself is never sent to Whisper - it would be echoed rather than
    obeyed. But the names inside it are exactly what the prompt window is for,
    and they are otherwise typed by the user and then thrown away. Only
    high-confidence shapes are taken: acronyms, and multi-word capitalised runs.

    This is a backstop, not a contract. The UI suggests the same kind of terms
    to the user, who confirms or removes them before anything is sent; this runs
    for callers that post prose with no confirmed list (or that leave budget
    spare). The two need not agree exactly, and nothing depends on them doing so.
    """
    if not prose:
        return []

    found: dict[str, str] = {}
    for match in _ACRONYM.finditer(prose):
        term = match.group(0)
        found.setdefault(term.casefold(), term)
    for match in _CAPITALISED_RUN.finditer(prose):
        term = _WHITESPACE.sub(" ", match.group(0)).strip()
        if term.split()[0].casefold() in _HARVEST_STOPWORDS:
            continue
        if len(term) > _MAX_TERM_CHARS:
            continue
        found.setdefault(term.casefold(), term)
    return list(found.values())


def _pack(terms: list[str], budget: int, count_tokens: TokenCounter) -> tuple[list[str], list[str], int]:
    """Fit as many terms as the budget allows, in order, keeping the head.

    faster-whisper keeps only the *last* 223 tokens of an over-long prompt, so
    letting it overflow would silently discard whichever terms the user put
    first - usually the ones they cared most about. Packing here inverts that.
    """
    used: list[str] = []
    dropped: list[str] = []
    used_tokens = 0

    for term in terms:
        candidate = ", ".join([*used, term]) + "."
        cost = count_tokens(candidate)
        if cost > budget:
            dropped.append(term)
            continue
        used.append(term)
        used_tokens = cost

    return used, dropped, used_tokens


def build_initial_prompt(
    confirmed_terms: str | None,
    context: str | None = None,
    count_tokens: TokenCounter | None = None,
    budget: int | None = None,
) -> PromptBuild:
    """Assemble a prompt from a confirmed term list and the free-text context.

    The result is a bare comma-separated list of terms. That is not a stylistic
    choice: every token spent on framing is a token not spent on a name, and
    framing is what leaks into the transcript.

    ``confirmed_terms`` is the list the user actually saw and approved, so it is
    packed first and always wins. ``context`` is their prose, which is never
    sent to Whisper as prose - only mined for proper nouns, and only to fill
    budget the confirmed list did not need. Nothing here infers intent from how
    the text was punctuated or laid out.
    """
    counter = count_tokens or estimate_tokens
    allowance = prompt_budget() if budget is None else budget

    prose_context = context
    explicit = parse_terms(confirmed_terms)
    used, dropped, used_tokens = _pack(explicit, allowance, counter)

    # Only spend what the explicit terms left behind, and never re-add something
    # the user already typed or that was just dropped for want of room.
    harvested_used: list[str] = []
    if used_tokens < allowance:
        already = {term.casefold() for term in [*used, *dropped]}
        candidates = [term for term in harvest_terms(prose_context) if term.casefold() not in already]
        if candidates:
            combined, _, combined_tokens = _pack([*used, *candidates], allowance, counter)
            harvested_used = combined[len(used):]
            used, used_tokens = combined, combined_tokens

    if not used:
        return PromptBuild(prompt=None, dropped_terms=dropped, budget_tokens=allowance)

    return PromptBuild(
        prompt=", ".join(used) + ".",
        used_terms=used,
        dropped_terms=dropped,
        harvested_terms=harvested_used,
        budget_tokens=allowance,
        used_tokens=used_tokens,
    )


def normalize_hotwords(raw: str | None) -> str | None:
    """Coerce the configured glossary into the single string faster-whisper wants.

    ``TranscriptionOptions.hotwords`` is typed ``Optional[str]`` and is called
    with ``.strip()`` (``faster_whisper/transcribe.py:1545``), so a list or dict
    raises ``AttributeError``. JSON forms are still accepted here because the
    setting used to document them: a dict contributes its keys, a list its items.
    """
    if raw is None:
        return None

    text = raw.strip()
    if not text:
        return None

    if text.startswith(("{", "[")):
        import json

        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, dict):
            text = ", ".join(str(key) for key in parsed)
        elif isinstance(parsed, list):
            text = ", ".join(str(item) for item in parsed)

    terms = parse_terms(text)
    return ", ".join(terms) if terms else None

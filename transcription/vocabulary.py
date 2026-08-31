"""Domain vocabulary offered to the user in the transcription options dialog.

Lives here, beside the code that serves it, rather than in an environment
variable: this is a reviewed, version-controlled list that belongs in diffs and
code review, not a deployment secret or a per-host toggle. Editing it is a
normal code change.

Nothing here reaches the decoder on its own. These are *suggestions* - the
client pre-fills them into the term list, and the user removes whatever does
not apply before starting. Terminology that should bias every recording without
passing through the user's hands belongs in the deployment glossary
(``Settings.hotwords``) instead, which is a separate channel with separate
false-positive risk.
"""

# Order is the order the user sees, and the order they enter the prompt:
# organisations first, then places, then domain terminology - most
# distinctive and most frequently misrecognised first, since that is the
# end of the list a truncation would never reach.
SUGGESTED_TERMS: list[str] = [
    "Serious Fraud Office",
    "SFO",
    "Counter Fraud Centre",
    "CFC",
    "Quay Street",
    "Auckland CBD",
    "forensic accountant",
    "financial investigation",
    "proceeds of crime",
    "beneficial ownership",
    "suspicious transaction",
    "search warrant",
    "bank statement",
    "conflict of interest",
]

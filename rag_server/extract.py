"""Text extraction and chunking.

Extraction returns per-page segments so page numbers survive into the chunk
metadata; LibreChat surfaces them as citation anchors.
"""

import csv
import io
import json

from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader

from config import CHUNK_OVERLAP, CHUNK_SIZE, MIN_CHUNK

# Extensions treated as plain UTF-8 text. Everything textual that isn't a PDF or
# DOCX lands here, including source code and config files.
TEXT_EXTENSIONS = {
    "txt", "md", "markdown", "rst", "log", "json", "jsonl", "yaml", "yml", "toml",
    "ini", "cfg", "conf", "env", "html", "htm", "xml", "css", "js", "jsx", "ts",
    "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs", "php",
    "sh", "bash", "zsh", "sql", "tex", "srt", "vtt",
}

SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | {"pdf", "docx", "xlsx", "xlsm", "csv", "tsv"}


class UnsupportedFileType(Exception):
    """Raised for a file type this server cannot turn into text."""


def extension_of(filename: str) -> str:
    _, _, ext = (filename or "").rpartition(".")
    return ext.lower()


def is_supported(filename: str) -> bool:
    return extension_of(filename) in SUPPORTED_EXTENSIONS


def extract_pages(data: bytes, filename: str) -> list[tuple[int | None, str]]:
    """Return [(page_number, text)]. page_number is None for unpaginated formats."""
    ext = extension_of(filename)

    if ext == "pdf":
        return _extract_pdf(data)
    if ext == "docx":
        return _extract_docx(data)
    if ext in {"xlsx", "xlsm"}:
        return _extract_xlsx(data)
    if ext in {"csv", "tsv"}:
        return _extract_delimited(data, "\t" if ext == "tsv" else ",")
    if ext in TEXT_EXTENSIONS:
        return [(None, _decode(data))]

    raise UnsupportedFileType(f"Unsupported file type: .{ext}")


def _decode(data: bytes) -> str:
    for encoding in ("utf-8", "utf-16", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _extract_pdf(data: bytes) -> list[tuple[int | None, str]]:
    reader = PdfReader(io.BytesIO(data))
    pages = []
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append((number, text))
    return pages


def _extract_xlsx(data: bytes) -> list[tuple[int | None, str]]:
    """One entry per worksheet, rows flattened to tab-separated lines.

    Sheet order is the page number, so a citation points at the sheet the text
    came from. `data_only` reads cached formula results rather than the formula
    source, which is what a reader of the spreadsheet would see.
    """
    workbook = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    sheets = []

    for number, sheet in enumerate(workbook.worksheets, start=1):
        lines = []
        for row in sheet.iter_rows(values_only=True):
            cells = [str(cell).strip() for cell in row if cell is not None and str(cell).strip()]
            if cells:
                lines.append("\t".join(cells))
        if lines:
            sheets.append((number, f"# {sheet.title}\n" + "\n".join(lines)))

    workbook.close()
    return sheets


def _extract_docx(data: bytes) -> list[tuple[int | None, str]]:
    document = Document(io.BytesIO(data))
    parts = [p.text for p in document.paragraphs if p.text.strip()]

    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))

    return [(None, "\n".join(parts))]


def _extract_delimited(data: bytes, delimiter: str) -> list[tuple[int | None, str]]:
    reader = csv.reader(io.StringIO(_decode(data)), delimiter=delimiter)
    rows = [delimiter.join(row) for row in reader if any(field.strip() for field in row)]
    return [(None, "\n".join(rows))]


def chunk_text(
    text: str,
    size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
    minimum: int = MIN_CHUNK,
) -> list[str]:
    """Split text into retrieval-sized chunks on natural boundaries.

    Paragraphs are the primary unit: any paragraph already carrying `minimum`
    characters becomes its own chunk, so distinct topics never get merged into
    one diluted embedding. Only short fragments are glued together, and only an
    oversized paragraph is split by length (with overlap, to avoid cutting an
    idea in half at the seam).
    """
    text = text.strip()
    if not text:
        return []
    if len(text) <= minimum:
        return [text]

    chunks: list[str] = []
    current = ""

    for block, forced in _split_blocks(text, size, overlap):
        if not current:
            current = block
            continue

        # A substantial paragraph stands on its own; close what we have.
        if len(current) >= minimum and not forced:
            chunks.append(current)
            current = block
            continue

        if len(current) + len(block) + 2 <= size:
            current = f"{current}\n\n{block}" if not forced else f"{current}\n{block}"
            continue

        chunks.append(current)
        # Overlap only matters where a split was forced mid-paragraph.
        current = (_carry_overlap(current, overlap) if forced else "") + block

    if current.strip():
        chunks.append(current)

    return [chunk.strip() for chunk in chunks if chunk.strip()]


def _split_blocks(text: str, size: int, overlap: int = CHUNK_OVERLAP) -> list[tuple[str, bool]]:
    """Yield (block, forced) where forced marks a length-driven split.

    Forced parts are cut to `size - overlap` so that prepending the overlap in
    chunk_text keeps the finished chunk within `size`.
    """
    blocks = [b for b in text.split("\n\n") if b.strip()]
    budget = max(1, size - max(0, overlap))
    refined: list[tuple[str, bool]] = []

    for block in blocks:
        if len(block) <= size:
            refined.append((block, False))
            continue
        refined.extend((part, True) for part in _split_oversized(block, budget))

    return refined


def _split_oversized(block: str, size: int) -> list[str]:
    for separator in ("\n", ". ", " "):
        parts = block.split(separator)
        if len(parts) == 1:
            continue

        merged: list[str] = []
        current = ""
        for part in parts:
            candidate = f"{current}{separator}{part}" if current else part
            if len(candidate) <= size:
                current = candidate
                continue
            if current:
                merged.append(current)
            current = part
        if current:
            merged.append(current)

        if all(len(m) <= size for m in merged):
            return merged

    return [block[i : i + size] for i in range(0, len(block), size)]


def _carry_overlap(previous: str, overlap: int) -> str:
    if overlap <= 0 or not previous:
        return ""
    tail = previous[-overlap:]
    # Start the overlap at a word boundary so chunks don't begin mid-token.
    _, space, remainder = tail.partition(" ")
    return f"{remainder if space else tail}\n"

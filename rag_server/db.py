"""LanceDB-backed vector store.

Every row carries the LibreChat user id. All reads and writes filter on it, so
one user's documents can never surface in another's search results.
"""

import os
import threading

import lancedb
import pyarrow as pa

from config import EMBED_DIM, LANCEDB_PATH

TABLE_NAME = "documents"

SCHEMA = pa.schema(
    [
        pa.field("id", pa.string()),
        pa.field("file_id", pa.string()),
        pa.field("user_id", pa.string()),
        # Empty string rather than null: agent knowledge files carry the agent's
        # entity_id, user attachments carry none, and SQL filters on "" are simpler.
        pa.field("entity_id", pa.string()),
        pa.field("source", pa.string()),
        pa.field("page", pa.int32()),
        pa.field("chunk_index", pa.int32()),
        pa.field("text", pa.string()),
        pa.field("vector", pa.list_(pa.float32(), EMBED_DIM)),
    ]
)

# LanceDB writes are not safe to interleave from multiple threads on one table.
_write_lock = threading.Lock()

os.makedirs(os.path.expanduser(LANCEDB_PATH), exist_ok=True)
db = lancedb.connect(os.path.expanduser(LANCEDB_PATH))


def _table():
    if TABLE_NAME in db.table_names():
        return db.open_table(TABLE_NAME)
    return db.create_table(TABLE_NAME, schema=SCHEMA)


def _quote(value: str) -> str:
    """Escape a value for a LanceDB SQL filter literal."""
    return "'" + str(value).replace("'", "''") + "'"


def _scope(user_id: str, file_id: str | None = None, entity_id: str | None = None) -> str:
    clauses = [f"user_id = {_quote(user_id)}"]
    if file_id is not None:
        clauses.append(f"file_id = {_quote(file_id)}")
    if entity_id:
        clauses.append(f"entity_id = {_quote(entity_id)}")
    return " AND ".join(clauses)


def add_chunks(rows: list[dict]) -> int:
    if not rows:
        return 0
    with _write_lock:
        _table().add(rows)
    return len(rows)


def search(
    user_id: str,
    file_id: str,
    vector: list[float],
    k: int,
    entity_id: str | None = None,
) -> list[dict]:
    """Vector search scoped to one user's copy of one file.

    prefilter=True applies the scope before the ANN scan, so k results are k
    matching rows rather than k nearest rows that are then filtered down.
    """
    table = _table()
    if table.count_rows() == 0:
        return []

    return (
        table.search(vector)
        .metric("cosine")
        .where(_scope(user_id, file_id, entity_id), prefilter=True)
        .limit(k)
        .to_list()
    )


def document_text(user_id: str, file_id: str) -> str:
    """Full text of a stored document, chunks reassembled in original order."""
    table = _table()
    if table.count_rows() == 0:
        return ""

    rows = table.search().where(_scope(user_id, file_id)).to_list()
    rows.sort(key=lambda row: (row.get("page") or 0, row.get("chunk_index") or 0))
    return "\n\n".join(row["text"] for row in rows)


def delete_files(user_id: str, file_ids: list[str]) -> int:
    """Delete every chunk of the given files belonging to this user."""
    if not file_ids:
        return 0

    table = _table()
    ids = ", ".join(_quote(file_id) for file_id in file_ids)
    condition = f"user_id = {_quote(user_id)} AND file_id IN ({ids})"

    with _write_lock:
        before = table.count_rows()
        table.delete(condition)
        return before - table.count_rows()


def file_exists(user_id: str, file_id: str) -> bool:
    table = _table()
    if table.count_rows() == 0:
        return False
    return len(table.search().where(_scope(user_id, file_id)).limit(1).to_list()) > 0

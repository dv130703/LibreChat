"""Authoring guidance for the `create_document` tool, held in its own LanceDB table.

Separate from `documents`: guidance is shared reference material with no owning
user, so it carries no `user_id` and is never mixed into a user's file search.
The agent consults it before writing a document, so the advice can be edited in
the store without touching LibreChat or redeploying anything.

Seed or re-seed with:  .venv/bin/python seed_guidance.py
"""

import threading

import lancedb
import pyarrow as pa

from config import EMBED_DIM, LANCEDB_PATH, embed_documents, embed_query

TABLE_NAME = "guidance"

CATEGORIES = ("checklist", "styling", "review")

SCHEMA = pa.schema(
    [
        pa.field("id", pa.string()),
        # One of CATEGORIES; lets callers pull a whole topic without a query.
        pa.field("category", pa.string()),
        pa.field("title", pa.string()),
        pa.field("text", pa.string()),
        # Lower sorts first when a category is returned whole.
        pa.field("rank", pa.int32()),
        pa.field("vector", pa.list_(pa.float32(), EMBED_DIM)),
    ]
)

_write_lock = threading.Lock()
_db = lancedb.connect(LANCEDB_PATH)


def _table():
    if TABLE_NAME in _db.table_names():
        return _db.open_table(TABLE_NAME)
    return _db.create_table(TABLE_NAME, schema=SCHEMA)


def _quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def replace_all(entries: list[dict]) -> int:
    """Rebuild the table from scratch. Seeding is idempotent rather than additive."""
    if not entries:
        return 0

    vectors = embed_documents([f"{e['title']}\n{e['text']}" for e in entries])
    rows = [
        {
            "id": entry["id"],
            "category": entry["category"],
            "title": entry["title"],
            "text": entry["text"],
            "rank": int(entry.get("rank", 0)),
            "vector": vector,
        }
        for entry, vector in zip(entries, vectors)
    ]

    with _write_lock:
        if TABLE_NAME in _db.table_names():
            _db.drop_table(TABLE_NAME)
        _db.create_table(TABLE_NAME, data=rows, schema=SCHEMA)

    return len(rows)


def count() -> int:
    if TABLE_NAME not in _db.table_names():
        return 0
    return _table().count_rows()


def by_category(category: str | None = None) -> list[dict]:
    """Every entry, or one category, in authoring order."""
    if count() == 0:
        return []

    table = _table()
    query = table.search()
    if category:
        query = query.where(f"category = {_quote(category)}")

    rows = query.to_list()
    rows.sort(key=lambda row: (row["category"], row.get("rank") or 0))
    return [
        {
            "id": row["id"],
            "category": row["category"],
            "title": row["title"],
            "text": row["text"],
        }
        for row in rows
    ]


def search(query: str, k: int = 4, category: str | None = None) -> list[dict]:
    if count() == 0:
        return []

    vector = embed_query(query)
    request = _table().search(vector).metric("cosine")
    if category:
        request = request.where(f"category = {_quote(category)}", prefilter=True)

    return [
        {
            "id": hit["id"],
            "category": hit["category"],
            "title": hit["title"],
            "text": hit["text"],
            "distance": float(hit["_distance"]),
        }
        for hit in request.limit(max(1, k)).to_list()
    ]

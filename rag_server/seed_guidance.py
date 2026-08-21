"""Seed the `guidance` table with authoring rules for the create_document tool.

Idempotent: rerun after editing ENTRIES and the table is rebuilt in place.
Run with:  .venv/bin/python seed_guidance.py
"""

import guidance

ENTRIES: list[dict] = [
    # ---------------------------------------------------------------- checklist
    {
        "id": "checklist-complete-content",
        "category": "checklist",
        "rank": 10,
        "title": "Write the finished document, never a skeleton",
        "text": (
            "Produce the complete, final text. Never emit placeholders such as TBD, TODO, "
            "XXX, [insert name], <your text here>, lorem ipsum, 'details to follow', or an "
            "empty table cell standing in for content you were asked to write. If a fact is "
            "genuinely unknown, either omit the row entirely or write an explicit, readable "
            "line such as 'Not recorded in the source material' - never a bracketed stub. "
            "A document containing a placeholder is a failed document."
        ),
    },
    {
        "id": "checklist-pick-format",
        "category": "checklist",
        "rank": 20,
        "title": "Choose the format from the shape of the content",
        "text": (
            "Use xlsx when the content is rows and columns that a reader will sort, filter, "
            "or total - question banks, trackers, inventories, schedules. Use docx when the "
            "content is prose the reader may edit - reports, letters, briefings, plans. Use "
            "pdf when the layout should not change - anything to be circulated or filed as "
            "final. If the user names a format, use it even if another would suit better."
        ),
    },
    {
        "id": "checklist-structure",
        "category": "checklist",
        "rank": 30,
        "title": "Give every document a title and a spine",
        "text": (
            "Always set `title`. For docx and pdf, open with a heading block, then order the "
            "body so a reader can navigate it: level 1 for the document title, level 2 for "
            "sections, level 3 for subsections. Never jump from level 1 to level 3. Prefer a "
            "table over a long bulleted list when each item has the same handful of "
            "attributes. Keep paragraphs to one idea."
        ),
    },
    {
        "id": "checklist-layout",
        "category": "checklist",
        "rank": 45,
        "title": "Lay a table out naturally - the tool reads the shape",
        "text": (
            "You may write a table the way a person would: a title line, a generated-on line, "
            "a blank row, then the header, then data, then a blank and a totals row. The tool "
            "locates the real header beneath any preamble, merges the title across the table "
            "width, anchors the frozen pane and filter dropdowns to that header, leaves blank "
            "separator rows unstyled, and emphasises any row whose first cell begins with "
            "Total, Subtotal, Grand Total or Average. Trailing columns that are empty "
            "throughout are dropped, and column types are read from the data rows only, so a "
            "totals banner never turns a numeric column into text. Do not pad the sheet with "
            "blank rows for spacing - one separator is enough."
        ),
    },
    {
        "id": "checklist-tables",
        "category": "checklist",
        "rank": 40,
        "title": "Build tables with a real header and even rows",
        "text": (
            "The first row of a table block, and the first row of every xlsx sheet, is the "
            "header - make it short column names, not data. Give every row the same number "
            "of cells as the header; ragged rows are padded with blanks and read as missing "
            "data. Put one value per cell rather than a comma-separated list. The tool "
            "profiles every column and recovers its real type, so you do not need to format "
            "anything yourself: it parses '1,250', '$49.99', '45%', '(500)' as an accounting "
            "negative, ISO dates like 2024-01-15, and yes/no/true/false, then applies the "
            "right Excel type, number format and alignment. Prefer plain JSON numbers where "
            "you can, but do not hand-format values into strings with symbols already applied "
            "in the hope of controlling the look - that is handled. One stray label in a "
            "numeric column, such as 'not recorded', makes the whole column text, so leave a "
            "cell empty instead. Name money columns with a word like revenue, cost, price or "
            "total so they are detected as currency."
        ),
    },
    {
        "id": "checklist-filename",
        "category": "checklist",
        "rank": 50,
        "title": "Name the file for a human",
        "text": (
            "Give `filename` a descriptive base name in plain words, e.g. 'Interview Plan - "
            "North Vault' - not 'output', 'document', or 'file1'. Do not add an extension; "
            "the tool appends the right one. Do not include a path, slashes, or a date unless "
            "the user asked for one."
        ),
    },
    {
        "id": "checklist-arguments",
        "category": "checklist",
        "rank": 60,
        "title": "Send arguments as real JSON structures",
        "text": (
            "`blocks` and `sheets` are arrays of objects. Pass them as actual arrays, not as a "
            "string containing JSON. Use `blocks` for docx and pdf, and `sheets` for xlsx - "
            "sending the wrong one produces an empty document. Every block needs a `type`; "
            "heading needs `text`, bullets needs `items`, table needs `rows`."
        ),
    },
    # ------------------------------------------------------------------ styling
    {
        "id": "styling-supported",
        "category": "styling",
        "rank": 10,
        "title": "What the tool can render",
        "text": (
            "Every format is styled automatically - you supply structure, the tool supplies "
            "the design. docx and pdf: a coloured title with a rule beneath it, coloured "
            "headings at levels 1-3, spaced body text, bulleted lists, bordered tables with a "
            "dark filled header row and banded alternate rows, page breaks, and a page-number "
            "footer on every page. xlsx: multiple named worksheets, a dark filled and frozen "
            "header row, filter dropdowns on that header, bordered and banded rows, columns "
            "auto-sized to content, wrapped text, and landscape fit-to-width printing. Use "
            "structure deliberately - one long paragraph wastes all of it. A totals row of "
            "live SUM formulas is appended to any xlsx table with two or more rows and a "
            "summable numeric column, so do not write your own totals row unless the user "
            "asked for a specific breakdown - if you do, label it 'Total' and the tool will "
            "leave it alone. Columns that are numbers but meaningless to add, such as year, "
            "id, code or rank, are excluded from totals automatically."
        ),
    },
    {
        "id": "styling-not-supported",
        "category": "styling",
        "rank": 20,
        "title": "What the tool cannot do - do not promise it",
        "text": (
            "There is no support for: bold or italic inside a sentence, choosing your own "
            "fonts or colours, images, charts, spreadsheet formulas, merged cells, footnotes, "
            "or a table of contents. Never tell the user a document contains these. If asked "
            "for a chart or formulas, produce the underlying data as a clean xlsx and say "
            "plainly that charts and formulas are not supported yet, so they can add them in "
            "Excel - the header already carries filter dropdowns, so the data is ready to "
            "pivot. Styling is automatic; never ask the user which colours or fonts they want."
        ),
    },
    {
        "id": "styling-quality",
        "category": "styling",
        "rank": 30,
        "title": "Use structure instead of decoration",
        "text": (
            "Because inline emphasis is unavailable, carry emphasis with structure: promote an "
            "important point to its own heading, or lift a set of facts into a table. Do not "
            "attempt to fake formatting with markdown - asterisks, backticks, underscores and "
            "pipe characters appear literally in the finished file. Write plain sentences. Use "
            "a pagebreak between major sections of a long pdf, not between every heading."
        ),
    },
    {
        "id": "styling-characters",
        "category": "styling",
        "rank": 40,
        "title": "Keep to characters the PDF fonts can encode",
        "text": (
            "pdf output uses the standard Helvetica family, which covers Latin text and common "
            "punctuation only. Prefer straight quotes and apostrophes over curly ones, a plain "
            "hyphen over en and em dashes, and spell out symbols rather than using arrows, "
            "mathematical operators, box-drawing characters, or emoji. Characters outside the "
            "font's range are dropped or render as stray marks in the finished pdf. docx and "
            "xlsx are unaffected by this limit."
        ),
    },
    # ------------------------------------------------------------------- review
    {
        "id": "review-before-returning",
        "category": "review",
        "rank": 10,
        "title": "Read the document back before returning it",
        "text": (
            "Before calling the tool, reread the content you assembled as if you were the "
            "recipient. Check: no placeholder or stub text anywhere; every heading is followed "
            "by real content; every table row matches its header width; no cell is empty by "
            "accident; no markdown characters left in the prose; the title matches what the "
            "document actually contains; nothing is repeated verbatim."
        ),
    },
    {
        "id": "review-truncation",
        "category": "review",
        "rank": 20,
        "title": "Never stop a document part-way",
        "text": (
            "Do not truncate a document to save effort and do not end with a trailing fragment "
            "such as an unfinished sentence or a heading with nothing under it. If the content "
            "is long, keep going - the tool has no length limit worth worrying about. If you "
            "genuinely cannot complete a section, leave it out and tell the user which section "
            "you omitted and why, in your reply rather than inside the file."
        ),
    },
    {
        "id": "review-faithfulness",
        "category": "review",
        "rank": 30,
        "title": "Do not invent facts to fill a document",
        "text": (
            "When the document draws on supplied material, every name, date, figure and "
            "quotation must come from that material. Do not fabricate a plausible-looking "
            "value to complete a table. If the source is silent, say so in the document. When "
            "the user asked for mock or sample data, the opposite applies - invent freely, but "
            "say clearly in your reply that the contents are fictitious."
        ),
    },
    {
        "id": "review-reply",
        "category": "review",
        "rank": 40,
        "title": "Summarise in the reply, do not repeat the document",
        "text": (
            "The file is attached automatically and appears at the end of your message. Do not "
            "paste the document's text, or a CSV version of it, into your reply. Instead say in "
            "a couple of lines what you produced, what it contains, and anything the reader "
            "should check or supply - for example a section you left out, or data you invented."
        ),
    },
]


def main() -> None:
    written = guidance.replace_all(ENTRIES)
    print(f"Seeded {written} guidance entries into the '{guidance.TABLE_NAME}' table.")
    for category in guidance.CATEGORIES:
        print(f"  {category}: {len(guidance.by_category(category))}")


if __name__ == "__main__":
    main()

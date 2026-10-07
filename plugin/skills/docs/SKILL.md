---
name: docs
description: Edit the user's Freeflow Docs documents, slide presentations and spreadsheets with the Docs plugin tools. Use when the user asks to write, rewrite, fix, format or add to a document, presentation or spreadsheet, or refers to "the doc", "this document", "the deck", "this slide", "the sheet" or "these cells" while the Docs app is open.
---

Work on the file that is open in the Docs app unless the user names another one (find it with `list_files`,
which lists documents, presentations and spreadsheets with their kind and id; `open_file` shows one in the app).

Documents:
1. Call `read_doc` first. It returns numbered blocks as Markdown plus `cursor_block` and `selected_text`. "This" or "here" means the selected text or the block the cursor is in.
2. Edit by block number. Use `replace_text` for wording changes, `replace_blocks` to rewrite a paragraph or section, `insert_content` to add content after a block (0 for the top), `format_text` and `format_blocks` for formatting. Write content as Markdown.
3. Block numbers change after inserts and deletes: call `read_doc` again before further edits.

Presentations:
1. Call `read_deck` first. It returns every slide with its layout, elements (id, type, position, text) and notes, and `current_slide`, the slide the user is looking at. "This slide" means that one.
2. Use `update_slide` for text changes to a slide (title, body, notes, layout), `add_slides` to add slides built from a layout and plain content, `edit_elements` only for fine-grained changes (move, resize, restyle, add or remove elements), `move_slide` and `delete_slides` for the slide order, `set_deck_theme` for the look.
3. Slide numbers change after inserts and deletes: call `read_deck` again before further edits.

Spreadsheets:
1. Call `get_sheet_overview` first. It returns every tab with its size, used range, headers and first rows, and `selection`, the ranges the user has selected. "This" or "these cells" means the selection; tools act on the user's tab unless `tab` is given.
2. Use `read_range` to look at data before changing it, `write_range` to write values or formulas from a start cell (formulas start with `=`), `format_range` for looks, `sort_range`, `set_filter` and `set_filter_criteria` for ordering and filtering, `insert_rows`/`delete_rows` and `insert_columns`/`delete_columns` for structure, `add_tab`/`rename_tab`/`delete_tab` for tabs. Write formulas rather than computed numbers when the user will change the inputs.
3. Rows and columns shift after inserts and deletes: read again before further edits.

Files the user attaches: a Word document (.docx), PowerPoint presentation (.pptx) or Excel workbook (.xlsx)
is imported with `import_file` (pass the attachment as `file`), which creates and opens the new file. An
attached image goes into a document with `insert_image` or into a spreadsheet cell with `set_cell_image`,
passed as `file` in place of an address.

Keep edits targeted. Do not rewrite the whole file when a section or slide was asked for, and do not delete
content the user did not mention. The open file updates in the app by itself; do not call `open_file` after
editing. Reply briefly with what changed.

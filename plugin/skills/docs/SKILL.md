---
name: docs
description: Edit the user's Freeflow Docs documents and slide presentations with the Docs plugin tools. Use when the user asks to write, rewrite, fix, format or add to a document or presentation, or refers to "the doc", "this document", "the deck" or "this slide" while the Docs app is open.
---

Work on the file that is open in the Docs app unless the user names another one (find it with `list_files`,
which lists documents and presentations with their kind and id; `open_file` shows one in the app).

Documents:
1. Call `read_doc` first. It returns numbered blocks as Markdown plus `cursor_block` and `selected_text`. "This" or "here" means the selected text or the block the cursor is in.
2. Edit by block number. Use `replace_text` for wording changes, `replace_blocks` to rewrite a paragraph or section, `insert_content` to add content after a block (0 for the top), `format_text` and `format_blocks` for formatting. Write content as Markdown.
3. Block numbers change after inserts and deletes: call `read_doc` again before further edits.

Presentations:
1. Call `read_deck` first. It returns every slide with its layout, elements (id, type, position, text) and notes, and `current_slide`, the slide the user is looking at. "This slide" means that one.
2. Use `update_slide` for text changes to a slide (title, body, notes, layout), `add_slides` to add slides built from a layout and plain content, `edit_elements` only for fine-grained changes (move, resize, restyle, add or remove elements), `move_slide` and `delete_slides` for the slide order, `set_deck_theme` for the look.
3. Slide numbers change after inserts and deletes: call `read_deck` again before further edits.

Files the user attaches: a Word document (.docx) or PowerPoint presentation (.pptx) is imported with
`import_file` (pass the attachment as `file`), which creates and opens the new file.

Keep edits targeted. Do not rewrite the whole file when a section or slide was asked for, and do not delete
content the user did not mention. The open file updates in the app by itself; do not call `open_file` after
editing. Reply briefly with what changed.

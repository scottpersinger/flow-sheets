// Shared helpers for picking and validating files to import: Excel workbooks (.xlsx, legacy .xls), PowerPoint
// presentations (.pptx), Word documents (.docx), PDFs and Markdown files (.md).

export const EXCEL_ACCEPT = '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
export const PPTX_ACCEPT = '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const DOCX_ACCEPT = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_ACCEPT = '.pdf,application/pdf';
export const MARKDOWN_ACCEPT = '.md,.markdown,text/markdown';
export const MAX_IMPORT_MB = 20;

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Open the browser's file picker for an Excel file; resolves to null if the user cancels. */
export const pickExcelFile = (): Promise<File | null> => pickFile(EXCEL_ACCEPT);
/** Open the browser's file picker for a PowerPoint file; resolves to null if the user cancels. */
export const pickPptxFile = (): Promise<File | null> => pickFile(PPTX_ACCEPT);
/** Open the browser's file picker for anything the home page can import. */
export const pickImportFile = (): Promise<File | null> => pickFile(`${EXCEL_ACCEPT},${PPTX_ACCEPT},${DOCX_ACCEPT},${PDF_ACCEPT},${MARKDOWN_ACCEPT}`);
/** Open the browser's file picker for a Word document; resolves to null if the user cancels. */
export const pickDocxFile = (): Promise<File | null> => pickFile(DOCX_ACCEPT);

export const isPowerPointFile = (file: File): boolean => /\.pptx$/i.test(file.name);
export const isWordFile = (file: File): boolean => /\.docx$/i.test(file.name);
export const isPdfFile = (file: File): boolean => /\.pdf$/i.test(file.name);
export const isMarkdownFile = (file: File): boolean => /\.(md|markdown)$/i.test(file.name);

function checkSize(file: File): string | null {
  return file.size > MAX_IMPORT_MB * 1024 * 1024 ? `This file is too large to import (${MAX_IMPORT_MB} MB maximum).` : null;
}

/** Client-side checks before uploading; returns an error message or null. The server detects the real format. */
export function checkExcelFile(file: File): string | null {
  if (!/\.xlsx?$/i.test(file.name)) return 'Please choose an Excel workbook (.xlsx or .xls).';
  return checkSize(file);
}

export function checkPptxFile(file: File): string | null {
  if (!isPowerPointFile(file)) return 'Please choose a PowerPoint presentation (.pptx).';
  return checkSize(file);
}

export function checkDocxFile(file: File): string | null {
  if (!isWordFile(file)) return 'Please choose a Word document (.docx).';
  return checkSize(file);
}

/** Checks for the home page, which takes any kind. */
export function checkImportFile(file: File): string | null {
  if (!/\.(xlsx?|pptx|docx|pdf|md|markdown)$/i.test(file.name)) return 'Please choose an Excel workbook (.xlsx or .xls), a PowerPoint presentation (.pptx), a Word document (.docx), a PDF (.pdf) or a Markdown file (.md).';
  return checkSize(file);
}

export function titleFromFileName(name: string): string {
  const file = { name } as File;
  return name.replace(/\.(xlsx?|pptx|docx|pdf|md|markdown)$/i, '').trim() || (isPowerPointFile(file) ? 'Imported presentation' : isMarkdownFile(file) ? 'Imported Markdown' : isWordFile(file) || isPdfFile(file) ? 'Imported document' : 'Imported spreadsheet');
}

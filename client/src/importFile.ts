// Shared helpers for picking and validating files to import: Excel workbooks (.xlsx, legacy .xls) and
// PowerPoint presentations (.pptx).

export const EXCEL_ACCEPT = '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
export const PPTX_ACCEPT = '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';
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
export const pickImportFile = (): Promise<File | null> => pickFile(`${EXCEL_ACCEPT},${PPTX_ACCEPT}`);

export const isPowerPointFile = (file: File): boolean => /\.pptx$/i.test(file.name);

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

/** Checks for the home page, which takes either kind. */
export function checkImportFile(file: File): string | null {
  if (!/\.(xlsx?|pptx)$/i.test(file.name)) return 'Please choose an Excel workbook (.xlsx or .xls) or a PowerPoint presentation (.pptx).';
  return checkSize(file);
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.(xlsx?|pptx)$/i, '').trim() || (isPowerPointFile({ name } as File) ? 'Imported presentation' : 'Imported spreadsheet');
}

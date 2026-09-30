// Shared helpers for picking and validating an Excel file (.xlsx or legacy .xls) for import.

export const EXCEL_ACCEPT = '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
export const MAX_IMPORT_MB = 20;

/** Open the browser's file picker; resolves to null if the user cancels. */
export function pickExcelFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = EXCEL_ACCEPT;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Client-side checks before uploading; returns an error message or null. The server detects the real format. */
export function checkExcelFile(file: File): string | null {
  if (!/\.xlsx?$/i.test(file.name)) return 'Please choose an Excel workbook (.xlsx or .xls).';
  if (file.size > MAX_IMPORT_MB * 1024 * 1024) return `This file is too large to import (${MAX_IMPORT_MB} MB maximum).`;
  return null;
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.xlsx?$/i, '').trim() || 'Imported spreadsheet';
}

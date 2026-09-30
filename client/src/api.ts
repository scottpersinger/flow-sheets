import type { SheetMeta, Workbook } from '../../shared/types.ts';

export interface User {
  id: string;
  email: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

async function uploadExcel<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    // The server detects .xlsx vs .xls from the file contents.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 413 ? 'This file is too large to import (20 MB maximum).' : (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? `Import failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User | null }>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  register: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/register', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),

  listSheets: () => request<{ sheets: SheetMeta[] }>('GET', '/api/sheets'),
  createSheet: (title: string) => request<{ sheet: SheetMeta }>('POST', '/api/sheets', { title }),
  getSheet: (id: string) => request<{ sheet: SheetMeta; workbook: Workbook }>('GET', `/api/sheets/${encodeURIComponent(id)}`),
  saveSheet: (id: string, workbook: Workbook, keepalive = false) =>
    request<{ sheet: SheetMeta }>('PUT', `/api/sheets/${encodeURIComponent(id)}`, { workbook }, keepalive ? { keepalive: true } : undefined),
  /** Import an Excel file (.xlsx or .xls) as a new spreadsheet. */
  importXlsx: (file: File, title: string) =>
    uploadExcel<{ sheet: SheetMeta; warnings: string[] }>(`/api/sheets/import?title=${encodeURIComponent(title)}`, file),
  /** Convert an Excel file (.xlsx or .xls) to workbook tabs without creating a spreadsheet. */
  convertXlsx: (file: File) => uploadExcel<{ workbook: Workbook; warnings: string[] }>('/api/import/xlsx', file),
  renameSheet: (id: string, title: string) => request<{ sheet: SheetMeta }>('PATCH', `/api/sheets/${encodeURIComponent(id)}`, { title }),
  deleteSheet: (id: string) => request<{ ok: true }>('DELETE', `/api/sheets/${encodeURIComponent(id)}`),
};

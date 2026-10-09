// The file list a tab was last showing: its folder and any search, as the query of the home page's
// address. An open file's links back to the list use it, so going back shows the same search results.
const KEY = 'ui.lastListing';

export function rememberListing(search: string): void {
  try {
    sessionStorage.setItem(KEY, search);
  } catch {
    // Not remembered, that's all.
  }
}

function last(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** The list as it was last shown. */
export const lastListingHref = (): string => `/${last()}`;

/** The list showing a folder ('' or absent is the top), with the search it had if that is the folder last shown. */
export function listingHref(folder?: string): string {
  const search = last();
  if ((new URLSearchParams(search).get('folder') ?? '') === (folder ?? '')) return `/${search}`;
  return folder ? `/?folder=${encodeURIComponent(folder)}` : '/';
}

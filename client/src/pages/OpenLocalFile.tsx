// The desktop app: /open?file=<path in the open folder> finds the library's file there and shows it. The
// app starts a window here when a file of Recents made it open another folder (desktop/main.js).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type RecentFile } from '../api.ts';
import { RECENTS_HREF, rememberRecents } from '../listing.ts';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pathOf = (kind: RecentFile['kind'], id: string) => (kind === 'deck' ? `/d/${id}` : kind === 'doc' ? `/doc/${id}` : kind === 'markdown' ? `/md/${id}` : kind === 'file' ? `/f/${id}` : `/s/${id}`);
/** The address that shows the file at a path inside the open folder, as one opened from Recents. */
export const openFromRecents = (file: string) => `/open?file=${encodeURIComponent(file)}&from=recents`;

/** /open?file=<path in the open folder>: finds the library's file there and shows it. `from=recents` makes Recents the list its breadcrumbs lead back to. */
export function OpenLocalFile() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const file = params.get('file') ?? '';
  const recents = params.get('from') === 'recents';

  useEffect(() => {
    if (recents) rememberRecents();
    api
      .resolveLocal(file)
      .then((r) => navigate(pathOf(r.kind, r.id), { replace: true }))
      .catch((e: unknown) => setError(message(e)));
  }, [file, recents, navigate]);

  return error ? (
    <div className="page-error">
      <div>“{file}” could not be opened: {error}</div>
      <Link className="btn" to={recents ? RECENTS_HREF : '/'}>
        Back
      </Link>
    </div>
  ) : (
    <div className="page-loading">Opening…</div>
  );
}

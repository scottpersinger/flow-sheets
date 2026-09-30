import { useEffect, useRef, type ReactNode } from 'react';
import { MOD } from '../commands.ts';
import type { SheetController } from '../state/controller.ts';
import type { SearchOptions } from '../state/search.ts';
import { useController } from '../state/useController.ts';

function Toggle(props: { on: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={`find-toggle${props.on ? ' on' : ''}`}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function FindBar({ ctl }: { ctl: SheetController }) {
  useController(ctl);
  const s = ctl.search!;
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = ctl.searchMatches();

  // Focus (and select) the input when opened or when the shortcut is pressed again.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [s.focusSeq]);

  const toggle = (key: keyof Omit<SearchOptions, 'query'>) => ctl.setSearchOptions({ [key]: !s[key] });
  const status = !s.query ? '' : hits.length === 0 ? 'No results' : s.current >= 0 && s.current < hits.length ? `${s.current + 1} of ${hits.length}` : `${hits.length} found`;

  return (
    <div className="find-bar" role="search" aria-label="Find in spreadsheet">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="find-icon">
        <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 10l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        className="find-input"
        placeholder={s.allTabs ? 'Find in all sheets' : 'Find in sheet'}
        aria-label="Find"
        value={s.query}
        spellCheck={false}
        onChange={(e) => ctl.setSearchOptions({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            ctl.searchStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            ctl.closeSearch();
          }
        }}
      />
      <span className={`find-status${s.query && !hits.length ? ' none' : ''}`} aria-live="polite">
        {status}
      </span>
      <button className="find-nav" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!hits.length} onMouseDown={(e) => e.preventDefault()} onClick={() => ctl.searchStep(-1)}>
        ↑
      </button>
      <button className="find-nav" title="Next match (Enter)" aria-label="Next match" disabled={!hits.length} onMouseDown={(e) => e.preventDefault()} onClick={() => ctl.searchStep(1)}>
        ↓
      </button>
      <span className="find-sep" />
      <Toggle on={s.matchCase} title="Match case" onClick={() => toggle('matchCase')}>
        Aa
      </Toggle>
      <Toggle on={s.wholeCell} title="Match entire cell contents" onClick={() => toggle('wholeCell')}>
        [ab]
      </Toggle>
      <Toggle on={s.formulas} title="Also search within formulas" onClick={() => toggle('formulas')}>
        fx
      </Toggle>
      <Toggle on={s.allTabs} title="Search all sheets" onClick={() => toggle('allTabs')}>
        All sheets
      </Toggle>
      <button className="find-close" title={`Close (Esc) · open with ${MOD}F`} aria-label="Close find" onClick={() => ctl.closeSearch()}>
        ✕
      </button>
    </div>
  );
}

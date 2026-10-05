/** Icon for presentations (slide decks). */
export function DeckIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#f4b400" />
      <path d="M7 9h18v12H7z" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M10 13h8M10 17h12" stroke="#fff" strokeWidth="2" />
      <path d="M16 21v4M12 25h8" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#0f9d58" />
      <path d="M8 9h16v14H8z" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M8 14h16M8 18h16M14 9v14" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

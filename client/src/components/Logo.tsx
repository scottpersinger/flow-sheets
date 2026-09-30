export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#0f9d58" />
      <path d="M8 9h16v14H8z" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M8 14h16M8 18h16M14 9v14" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

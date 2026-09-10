/**
 * The mark is a cue: two lines of dialogue under a lamp. It is drawn rather
 * than imported so it inherits the theme's ink and needs no asset request.
 */
export function Logo({ size = 26 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Subtitle Translator"
      fill="none"
    >
      <rect
        x="2.5"
        y="5.5"
        width="27"
        height="21"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.75"
        opacity="0.45"
      />
      <path
        d="M8 11.5h9"
        stroke="var(--accent)"
        strokeWidth="2.25"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path d="M8 17h16" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      <path d="M8 21.5h11" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  );
}

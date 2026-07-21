interface BrandMarkProps {
  className?: string;
  title?: string;
  tone?: 'default' | 'onDark';
}

export function BrandMark({ className = 'h-8 w-8', title, tone = 'default' }: BrandMarkProps) {
  const onDark = tone === 'onDark';

  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <rect width="40" height="40" rx="9" fill={onDark ? '#D7F25A' : '#10120F'} />
      <path
        d="M10.5 8.5v13.25c0 4.28 3.47 7.75 7.75 7.75H31.5"
        fill="none"
        stroke={onDark ? '#10120F' : '#D7F25A'}
        strokeLinecap="square"
        strokeWidth="5"
      />
      <path
        d="M18.25 9.5v8.25a4 4 0 0 0 4 4h8.25"
        fill="none"
        stroke="#F3F0E6"
        strokeLinecap="square"
        strokeWidth="2"
      />
      <circle cx="31.5" cy="29.5" r="2.5" fill={onDark ? '#10120F' : '#D7F25A'} />
    </svg>
  );
}

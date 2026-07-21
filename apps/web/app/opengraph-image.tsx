import { ImageResponse } from 'next/og';

export const alt = 'Lemonize — from origin to edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: '#10120F',
        backgroundImage:
          'linear-gradient(rgba(243,240,230,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(243,240,230,.06) 1px, transparent 1px)',
        backgroundSize: '42px 42px',
        color: '#F3F0E6',
        padding: '64px 70px',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <svg width="64" height="64" viewBox="0 0 40 40">
          <rect width="40" height="40" rx="9" fill="#D7F25A" />
          <path
            d="M10.5 8.5v13.25c0 4.28 3.47 7.75 7.75 7.75H31.5"
            fill="none"
            stroke="#10120F"
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
          <circle cx="31.5" cy="29.5" r="2.5" fill="#10120F" />
        </svg>
        <div style={{ display: 'flex', fontSize: 34, fontWeight: 700, letterSpacing: '-1.5px' }}>
          lemonize
        </div>
        <div
          style={{
            display: 'flex',
            marginLeft: 12,
            color: '#969C8B',
            fontSize: 14,
            letterSpacing: '3px',
          }}
        >
          EDGE / 01
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 940 }}>
        <div
          style={{
            display: 'flex',
            color: '#D7F25A',
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: '3px',
            textTransform: 'uppercase',
          }}
        >
          Global package delivery
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 20,
            fontSize: 92,
            lineHeight: 0.92,
            fontWeight: 700,
            letterSpacing: '-6px',
          }}
        >
          From origin to edge.
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: '1px solid rgba(243,240,230,.14)',
          paddingTop: 28,
        }}
      >
        <div style={{ display: 'flex', color: '#B9BEAF', fontSize: 20 }}>
          npm-compatible gateway + immutable native registry
        </div>
        <div style={{ display: 'flex', color: '#D7F25A', fontSize: 18, fontFamily: 'monospace' }}>
          npm.lemonize.cyou
        </div>
      </div>
    </div>,
    size,
  );
}

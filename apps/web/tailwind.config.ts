import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm monochrome canvas
        paper: '#F3F0E6',
        surface: '#FBF9F2',
        line: '#D9DCCE',
        ink: {
          900: '#10120F',
          600: '#62675B',
        },
        // Brand — used sparingly, as the pale-yellow pastel accent only
        lemon: {
          bg: '#EAF4B5',
          text: '#465800',
          swatch: '#D7F25A',
        },
        carbon: '#10120F',
        graphite: '#171A15',
        citron: '#D7F25A',
        pulp: '#F3F0E6',
        steel: '#969C8B',
        pastel: {
          blueBg: '#E2EEE8',
          blueText: '#315F55',
          greenBg: '#E6F0D9',
          greenText: '#3C6335',
          redBg: '#F5E3DD',
          redText: '#934437',
        },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['var(--font-editorial)', 'Georgia', 'serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      maxWidth: {
        content: '72rem',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        spring: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      boxShadow: {
        subtle: '0 14px 36px rgba(16, 18, 15, 0.07)',
        none: '0 0 0 rgba(0,0,0,0)',
      },
    },
  },
  plugins: [],
} satisfies Config;

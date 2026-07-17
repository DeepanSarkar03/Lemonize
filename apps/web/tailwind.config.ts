import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm monochrome canvas
        paper: '#F7F6F3',
        surface: '#FFFFFF',
        line: '#EAEAEA',
        ink: {
          900: '#111111',
          600: '#5B5852',
        },
        // Brand — used sparingly, as the pale-yellow pastel accent only
        lemon: {
          bg: '#FBF3DB',
          text: '#956400',
          swatch: '#E8CA2E',
        },
        pastel: {
          blueBg: '#E1F3FE',
          blueText: '#1F6C9F',
          greenBg: '#EDF3EC',
          greenText: '#346538',
          redBg: '#FDEBEC',
          redText: '#9F2F2D',
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
        subtle: '0 2px 8px rgba(17, 17, 17, 0.04)',
        none: '0 0 0 rgba(0,0,0,0)',
      },
    },
  },
  plugins: [],
} satisfies Config;

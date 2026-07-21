import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Lemonize',
    short_name: 'Lemonize',
    description: 'Package infrastructure from origin to edge.',
    start_url: '/',
    display: 'standalone',
    background_color: '#F3F0E6',
    theme_color: '#10120F',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}

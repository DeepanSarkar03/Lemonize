import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date('2026-07-21T00:00:00.000Z');
  return ['/', '/docs', '/explore', '/terms', '/privacy'].map((path) => ({
    url: `https://lemonize.cyou${path}`,
    lastModified: updated,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : path === '/docs' ? 0.8 : 0.6,
  }));
}

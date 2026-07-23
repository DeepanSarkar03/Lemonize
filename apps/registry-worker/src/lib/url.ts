export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

export function appwriteApiBaseUrl(endpoint: string): string {
  const normalized = stripTrailingSlashes(endpoint);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

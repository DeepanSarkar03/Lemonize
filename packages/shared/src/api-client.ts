import type {
  LimitsResponse,
  PackageMetadata,
  PublishIntent,
  PublishIntentResponse,
  PublishFinalizeResponse,
  SearchResultItem,
  TokenInfo,
  UserPublic,
  DeviceStartResponse,
  CreatedToken,
  TokenScope,
} from './types.js';
import type { ApiErrorBody } from './errors.js';

export interface ClientOptions {
  registry: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody | { error?: { code?: string } } | null,
    message: string,
    private readonly responseRequestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
  get code(): string {
    return this.body?.error?.code ?? 'UNKNOWN';
  }
  get requestId(): string | null {
    const requestId = (this.body as ApiErrorBody | null)?.error?.requestId;
    return typeof requestId === 'string' && requestId ? requestId : this.responseRequestId;
  }
}

/** Minimal typed client used by both the CLI and (server components of) the web app. */
export class LemonizeClient {
  private readonly base: string;
  private readonly token?: string | null;
  private readonly f: typeof fetch;
  private readonly ua: string;

  constructor(opts: ClientOptions) {
    this.base = opts.registry.replace(/\/+$/, '');
    this.token = opts.token ?? null;
    this.f = opts.fetchImpl ?? fetch;
    this.ua = opts.userAgent ?? 'lemonize-client';
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': this.ua, ...extra };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text();
    let parsed: ApiErrorBody | { error?: { code?: string; message?: string } } | T | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new ApiClientError(
          res.status,
          null,
          `Registry returned a non-JSON response (${res.headers.get('content-type') ?? 'unknown content type'}).`,
          res.headers.get('x-request-id'),
        );
      }
    }
    if (!res.ok) {
      const errorBody = parsed as
        ApiErrorBody | { error?: { code?: string; message?: string } } | null;
      const msg = errorBody?.error?.message ?? `Request failed with ${res.status}`;
      throw new ApiClientError(res.status, errorBody, msg, res.headers.get('x-request-id'));
    }
    return parsed as T;
  }

  limits(): Promise<LimitsResponse> {
    return this.f(`${this.base}/v1/limits`, { headers: this.headers() }).then((r) => this.json(r));
  }

  me(): Promise<{ user: UserPublic }> {
    return this.f(`${this.base}/v1/auth/me`, { headers: this.headers() }).then((r) => this.json(r));
  }

  getPackage(name: string): Promise<PackageMetadata> {
    return this.f(`${this.base}/v1/packages/${encodeURIComponent(name)}`, {
      headers: this.headers(),
    }).then((r) => this.json(r));
  }

  search(q: string): Promise<{ results: SearchResultItem[] }> {
    return this.f(`${this.base}/v1/search?q=${encodeURIComponent(q)}`, {
      headers: this.headers(),
    }).then((r) => this.json(r));
  }

  createPackage(body: { name: string; description?: string; visibility?: string }) {
    return this.f(`${this.base}/v1/packages`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }).then((r) => this.json(r));
  }

  createPublishIntent(
    name: string,
    intent: PublishIntent,
    options: { idempotencyKey?: string } = {},
  ): Promise<PublishIntentResponse> {
    const extra: Record<string, string> = { 'content-type': 'application/json' };
    if (options.idempotencyKey) extra['idempotency-key'] = options.idempotencyKey;
    return this.f(`${this.base}/v1/packages/${encodeURIComponent(name)}/versions`, {
      method: 'POST',
      headers: this.headers(extra),
      body: JSON.stringify(intent),
    }).then((r) => this.json(r));
  }

  async uploadTarball(uploadUrl: string, uploadToken: string, body: Uint8Array): Promise<void> {
    const res = await this.f(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/gzip',
        'x-lemonize-upload-token': uploadToken,
        'content-length': String(body.byteLength),
      },
      body,
    });
    if (!res.ok) await this.json(res);
  }

  finalize(name: string, version: string, uploadToken: string): Promise<PublishFinalizeResponse> {
    return this.f(
      `${this.base}/v1/packages/${encodeURIComponent(name)}/versions/${version}/finalize`,
      {
        method: 'POST',
        headers: this.headers({
          'content-type': 'application/json',
          'x-lemonize-upload-token': uploadToken,
        }),
        body: JSON.stringify({}),
      },
    ).then((r) => this.json<PublishFinalizeResponse>(r));
  }

  tarballUrl(name: string, version: string): string {
    return `${this.base}/v1/packages/${encodeURIComponent(name)}/versions/${version}/tarball`;
  }

  listTokens(): Promise<{ tokens: TokenInfo[] }> {
    return this.f(`${this.base}/v1/tokens`, { headers: this.headers() }).then((r) => this.json(r));
  }

  createToken(body: {
    label: string;
    expiresInDays?: number;
    scopes?: TokenScope[];
  }): Promise<CreatedToken> {
    return this.f(`${this.base}/v1/tokens`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }).then((r) => this.json(r));
  }

  revokeToken(id: string): Promise<{ ok: true }> {
    return this.f(`${this.base}/v1/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    }).then((r) => this.json(r));
  }

  deviceStart(username?: string): Promise<DeviceStartResponse> {
    return this.f(`${this.base}/v1/auth/device/start`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ username }),
    }).then((r) => this.json(r));
  }

  devicePoll(deviceCode: string): Promise<{ status: string; token?: string; user?: UserPublic }> {
    return this.f(`${this.base}/v1/auth/device/poll`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ deviceCode }),
    }).then((r) => this.json(r));
  }
}

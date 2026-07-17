/** Wire types shared between Worker, CLI and web. Kept adapter-friendly. */

export type Visibility = 'public' | 'private';

export interface UserPublic {
  id: string;
  username: string;
  email?: string;
  createdAt: string;
}

export interface BinMap {
  [command: string]: string;
}

export interface PackageManifest {
  name: string;
  version: string;
  description?: string;
  main?: string;
  types?: string;
  module?: string;
  type?: 'module' | 'commonjs';
  bin?: BinMap | string;
  files?: string[];
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  /** Dependencies resolved from the Lemonize registry rather than npm. */
  lemonizeDependencies?: Record<string, string>;
  lemonize?: {
    access?: Visibility;
    tag?: string;
  };
  [key: string]: unknown;
}

export interface PackageVersion {
  version: string;
  tarball: string; // absolute download URL
  integrity: string; // sha512 SRI
  shasum: string; // sha256 hex
  unpackedSize: number;
  tarballSize: number;
  fileCount: number;
  engines?: { node?: string };
  moduleType?: 'module' | 'commonjs';
  bin?: BinMap;
  publishedBy: string;
  publishedAt: string;
  deprecated?: string | null;
  yanked?: boolean;
}

export interface PackageMetadata {
  name: string;
  normalizedName: string;
  scope: string | null;
  visibility: Visibility;
  description?: string;
  latest?: string;
  distTags: Record<string, string>;
  maintainers: string[];
  createdAt: string;
  updatedAt: string;
  versions: Record<string, PackageVersion>;
}

export interface SearchResultItem {
  name: string;
  description?: string;
  latest?: string;
  downloads: number;
  updatedAt: string;
}

export interface LimitsResponse {
  maxTarballSizeBytes: number;
  maxPackageFiles: number;
  rateLimitReadsPerMinute: number;
  rateLimitWritesPerMinute: number;
  allowPublicPublish: boolean;
  allowPrivatePackages: boolean;
  registryBaseUrl: string;
  /** Single-publisher registries set this true; only the owner may publish. */
  publishRestricted?: boolean;
  /** False when accounts cannot be self-created (download-only for others). */
  openSignup?: boolean;
  publisherCount?: number;
}

/** Publish intent the CLI sends before uploading a tarball. */
export interface PublishIntent {
  manifest: PackageManifest;
  integrity: string; // sha512 SRI of the tarball
  shasum: string; // sha256 hex
  tarballSize: number;
  unpackedSize: number;
  fileCount: number;
  access?: Visibility;
  tag?: string;
}

export type TokenScope = 'read' | 'publish' | 'manage:packages' | 'manage:tokens';

export interface PublishIntentResponse {
  packageId: string;
  version: string;
  uploadUrl: string; // where the CLI PUTs the tarball
  uploadToken: string; // short-lived, single-version scoped
  method: 'PUT';
  expiresAt: string;
}

export interface PublishFinalizeResponse {
  name: string;
  version: string;
  integrity: string;
  shasum: string;
  tarballSize: number;
  tag: string;
  latest: boolean;
  status: 'scanning' | 'published';
  scanJobId?: string;
}

export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: string;
}

export interface TokenInfo {
  id: string;
  label: string;
  prefix: string; // "lem_live_" + first chars
  scopes?: TokenScope[];
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
}

export interface CreatedToken {
  id: string;
  token: string;
  label: string;
  scopes: TokenScope[];
  createdAt: string;
  expiresAt?: string | null;
}

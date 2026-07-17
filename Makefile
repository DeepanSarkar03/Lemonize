.PHONY: install install-frozen dev build test lint typecheck ci audit audit-prod audit-dev web-build wrangler-dry-run npm-proxy-dry-run artifact-security smoke appwrite-backup-policy appwrite-backup-verify seed deploy-worker deploy-npm-proxy-staging deploy-npm-proxy-production deploy-web cli-link clean

install: ; pnpm install
install-frozen: ; pnpm install --frozen-lockfile
dev: ; pnpm dev
build: ; pnpm build
test: ; pnpm test
lint: ; pnpm lint
typecheck: ; pnpm typecheck
ci: install-frozen lint typecheck build test
audit: audit-prod audit-dev
audit-prod: ; pnpm audit --prod --audit-level high
audit-dev: ; pnpm audit --dev --audit-level high
web-build: ; pnpm --filter @lemonize/web build
wrangler-dry-run: ; pnpm --filter @lemonize/registry-worker exec wrangler deploy --env production --dry-run
npm-proxy-dry-run: ; pnpm --filter @lemonize/npm-proxy-worker exec wrangler deploy --env production --dry-run
artifact-security: ; pnpm --filter @lemonize/package-format test -- test/safe-path.test.ts test/integrity.test.ts test/pack-extract.test.ts && pnpm --filter @lemonize/cli test -- test/security.test.ts test/install.test.ts
smoke: ; bash scripts/ops/smoke-test.sh
appwrite-backup-policy: ; bash scripts/ops/appwrite-backup.sh reconcile
appwrite-backup-verify: ; bash scripts/ops/appwrite-backup.sh verify
seed: ; pnpm seed
deploy-worker: ; pnpm deploy:worker
deploy-npm-proxy-staging: ; pnpm deploy:npm-proxy:staging
deploy-npm-proxy-production: ; pnpm deploy:npm-proxy:production
deploy-web: ; pnpm deploy:web
cli-link: ; pnpm cli:link
clean: ; rm -rf node_modules **/node_modules **/dist **/.next **/.turbo

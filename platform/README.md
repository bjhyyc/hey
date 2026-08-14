# PetPack Studio server-side core

This directory contains server-only, dependency-injected contracts for the product workflow. It deliberately contains no ModelArk key, Kaipay credential, administrator video prompt, public media URL, or customer-specific asset.

Key modules:

- `src/config/model-registry.js` — account-provided ModelArk IDs, region, quotas, retries, and callback configuration.
- `src/providers/modelark-client.js` — Seedream / Seedance 2.0 request, polling, and callback-ticket contract. Provider output must be archived immediately into private storage.
- `src/providers/kaipay-payment-provider.js` — fail-closed Kaipay domain adapter. Exact wire fields, signing, verification, query, refund, and callback acknowledgement stay inside a separately pinned protocol adapter; development simulation is isolated in `simulated-payment-provider.js`.
- `src/workflow/production-workflow.js` — paid-order to delivery queue plan, deterministic dedupe keys, retries, and prompt-release gate.
- `src/qa/` and `src/media/` — `character_canvas_v1`, worker-local segmentation/FFmpeg plan, trusted re-probe, and fail-closed action QA.
- `src/petpack/build.js` — creates a checksummed, seven-action, original-client-compatible archive only after every action passes QA and a post-build probe.
- `src/petpack/package-contract.js`, `src/petpack/private-petpack-workspace.js`, and `src/petpack/delivery-validator.js` — freeze the exact seven QA inputs and display name, create byte-deterministic private PetPacks, re-extract/re-probe every action, bind import/interaction evidence to the archive checksum, and fail production closed unless both the clean upstream tree and a real Electron runner are attested.
- `src/storage/private-object-store.js` — private object keys and temporary signed upload/download grants.
- `src/api/petpack-studio-service.js` — normal-user API boundary for checkout, bounded owner project summaries, three-to-four-photo upload grants, trusted uploaded-object verification, character-master confirmation, progress, and final download grants. Its DTOs deliberately omit prompts, provider task IDs, storage keys, QA internals, and secrets.
- `src/api/admin-prompt-service.js` — administrator-only draft/copy/publish/rollback lifecycle for the seven prompt versions.
- `src/api/admin-operations-service.js` — administrator-only, keyset-paginated operational health view with explicit redaction of customer, prompt, storage, and provider data.
- `src/http/petpack-studio-http-api.js` — framework-neutral HTTP command adapter with server-injected identity, strict request shapes, safe response allowlists, and a raw-byte Kaipay notification boundary.
- `src/persistence/postgres-database.js` — concrete server-only `pg` pool and transaction adapter with bounded timeouts, rollback, minimum schema/version readiness checks, and verified TLS enforcement in production.
- `src/runtime/create-local-auth-api.js` and `src/http/node-http-server.js` — development-only, loopback-bound CloudBase phone-session API. It can expose authentication before checkout and generation services exist; all normal product routes remain unavailable in this mode.
- `src/auth/authorization.js` — small server-side actor, ownership, and administrator checks; HTTP/session implementation remains deployment-specific.
- `sql/001_petpack_studio.sql` — PostgreSQL 15+ schema for private assets, payment/audit records, prompt versions, production runs, seven action rows, QA, delivery, and the durable outbox.
- `src/persistence/postgres-transactional-workflow-store.js` and `sql/002_transactional_workflow.sql` — an optimistic-lock PostgreSQL transition writer plus leased outbox dispatcher. It writes run state, immutable seven-action rows, and ID-only queue work in one transaction; individual action QA uses database rows rather than a race-prone JSON completion array.
- `src/persistence/postgres-petpack-studio-repository.js` — the server-only PostgreSQL implementation of checkout, bounded owner project listing, private three-to-four-photo reservation/acceptance, project progress, delivery ownership, encrypted Kaipay notification retention, verified payment reconciliation, and atomic administrator prompt version/publication-audit persistence. It exposes only IDs and private object keys to trusted server code.
- `src/workers/production-job-worker.js`, `src/persistence/postgres-production-worker-repository.js`, and `sql/003_production_job_execution.sql` / `sql/004_video_polling.sql` — leased, idempotent Seedance action submission and authoritative delayed polling. Submission intent is persisted before the external request; explicit rejections may retry, transport/5xx ambiguity is isolated for reconciliation, and a successful provider output is immediately archived with trusted checksum/size/type metadata before an ID-only processing job is released.
- `src/workers/image-master-worker.js`, `src/persistence/postgres-image-master-worker-repository.js`, `src/media/private-master-image-workspace.js`, `src/qa/master-image-quality-gate.js`, and `sql/007_image_master_pipeline.sql` — leased Seedream awake/sleep execution with server-only published prompt snapshots, request-intent ambiguity isolation, immediate private archival, isolated 1280×720 PNG normalization, anatomical/identity/content QA evidence, and retry-safe finalizers. Sleeping-image QA failure releases the existing automatic retry transition without another user click; no image prompt text is seeded.
- `src/workers/petpack-pipeline-worker.js`, `src/persistence/postgres-petpack-worker-repository.js`, and `sql/006_petpack_delivery_pipeline.sql` — the run-level media gate, package build, frozen-version validation, and atomic ready-delivery chain. Queue payloads contain only `runId`; active DB leases are never acknowledged as success; build, both QA reports, run transition, and delivery remain checksum/ownership/version bound.

### Web/API integration contract

The browser must calculate a selected source image's SHA-256 and byte length
before asking the server for its signed upload URL. The resulting private object
is then inspected through the storage driver using server credentials before it
can be accepted. A client-provided checksum or MIME value alone is never proof
of an uploaded photo.

The persistence adapter must make `acceptSourcePhoto` atomic and return:

```js
{ acceptedCount: 3, allAcceptedNow: true, sourcePhotoRevisionId: "immutable-revision" }
```

Only the one request that durably claims `allAcceptedNow` may release the
awake-master job. The PostgreSQL adapter must then apply the same transaction /
outbox discipline to payment reconciliation and all later workflow transitions.

The Next.js web application exposes only `/api/studio/*` to browsers. That
server-only gateway injects the configured product plan for checkout, forwards exactly one
configured session cookie, requires the configured same origin for mutations,
and allowlists only normal-user and administrator prompt routes. It does not
proxy the raw Kaipay callback. The checkout response includes only the newly
owned `project.id`, safe order fields, and the temporary cashier URL so the
browser can resume the real project-ID workflow without learning provider or
storage identifiers.

### Local authentication-only runtime

Install the isolated server dependency from the `platform` directory so the
Electron client does not acquire a PostgreSQL driver:

```powershell
Push-Location platform
npm install --ignore-scripts
Pop-Location
```

After the current-user environment variables and the migrated local database
are available, start the loopback API from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local-platform-api.ps1
```

`GET http://127.0.0.1:8787/healthz` reports only readiness. The local website
may point `PETPACK_STUDIO_API_ORIGIN` at that origin without defining a paid
plan; authentication routes work, while checkout remains fail-closed until
`PETPACK_STUDIO_PLAN_CODE` is configured. Keep the public phone-auth UI gate
off until a controlled real-number SMS test is explicitly approved.

The opt-in database suites exercise the real local schema without contacting
CloudBase, Kaipay, ModelArk, or object storage. They cover authentication plus
concurrent checkout/payment/run/outbox creation, two-photo acceptance, source
revision binding, prompt publication, rollback, and fixture cleanup:

```powershell
$env:PETPACK_POSTGRES_URL = [Environment]::GetEnvironmentVariable('PETPACK_POSTGRES_URL', 'User')
$env:PETPACK_PLATFORM_MODE = 'development'
$env:PETPACK_RUN_POSTGRES_INTEGRATION = '1'
npx vitest run tests/platform/postgres-auth-integration.test.js tests/platform/postgres-studio-integration.test.js
```

Run the contract suite from the repository root:

```powershell
npx vitest run tests/platform/cloud-foundations.test.js tests/platform/stage-two-services.test.js tests/platform/transactional-workflow.test.js tests/platform/transactional-workflow-security.test.js tests/platform/postgres-petpack-studio-repository.test.js tests/platform/production-job-worker.test.js tests/platform/image-master-pipeline.test.js tests/platform/postgres-image-master-worker-repository.test.js tests/platform/petpack-pipeline.test.js tests/platform/postgres-petpack-worker-repository.test.js
```

Production requires the unresolved account, merchant, policy, and real-media items listed in `D:\桌宠\BLOCKED.md`.

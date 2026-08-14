# Kaipay EPay V1 production setup

The application is pinned to the official domestic Kaipay EPay V1 gateway and
adapter version. Do not place the merchant key in Git, a shell history, chat,
Docker image layers, or Compose environment values.

## 1. Find the two merchant values

Open the Kaipay merchant console and locate the EPay configuration:

- `pid`: the positive decimal merchant ID;
- EPay key: the shared MD5 signing secret.

The merchant ID is non-secret. Treat the EPay key as a production secret.

## 2. Create the secret file on the server

Create an operator-owned file outside every release directory, for example:

`/opt/petpack/config/payment/secrets/kaipay_credentials.json`

Its entire content must have this exact JSON shape:

```json
{"epayKey":"REPLACE_DIRECTLY_ON_THE_SERVER"}
```

Use owner-only read/write permissions. Mount it read-only into the Studio API
container, for example at `/run/secrets/kaipay_credentials_json`, and configure
`KAIPAY_CREDENTIALS_JSON_FILE=/run/secrets/kaipay_credentials_json`. Never set
both `KAIPAY_CREDENTIALS_JSON` and `KAIPAY_CREDENTIALS_JSON_FILE`.

The callback ciphertext key is separate. Keep
`PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY_FILE` configured with its own
32-byte key; it must not reuse the EPay key.

## 3. Configure non-secret production values

```text
PETPACK_PLATFORM_MODE=production
KAIPAY_MERCHANT_ID=<positive decimal pid>
KAIPAY_API_BASE_URL=https://api.kaipay.cn
KAIPAY_NOTIFY_BASE_URL=https://api.heyirmy.com/api/payments/kaipay/notify
KAIPAY_RETURN_BASE_URL=https://heyirmy.com/projects/payment-return
KAIPAY_ADAPTER_VERSION=kaipay-epay-v1-md5/1
KAIPAY_DEFAULT_CHANNEL=ALIPAY
KAIPAY_REQUEST_TIMEOUT_MS=15000
KAIPAY_ALLOW_SIMULATED_PAYMENTS=false
```

The application appends the platform order ID to the notification base URL.
The exact provider callback therefore looks like:

`GET /api/payments/kaipay/notify/<platformOrderId>?pid=...&trade_no=...&...`

The customer chooses either Alipay or WeChat before checkout. The backend maps
those choices to EPay `alipay` and `wxpay`; UnionPay is intentionally not
offered by this product.

## 4. Required checks before the first real order

1. Run `npm run verify:kaipay` from `platform/`. It performs only the official
   read-only `act=query` merchant check, prints no merchant balance, username,
   key, or URL, and creates no order.
2. Run the production configuration preflight without printing secret values.
3. Confirm the callback URL is publicly reachable through Caddy to the full
   Studio API; the auth-only API is not sufficient.
4. Keep the public purchase gate closed.
5. Agree on one minimum-value test order and a hard spending limit.
6. Confirm an invalid signature returns `fail` and cannot change order state.
7. Confirm a valid notification is followed by `/epay/api` order query and only
   then returns plain text `success`.
8. Replay the same notification and prove the workflow starts once.

The public EPay V1 documentation does not define a refund endpoint. Automatic
refunds remain fail-closed until a separate official Kaipay refund protocol is
provided and tested.

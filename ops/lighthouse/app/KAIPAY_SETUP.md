# Kaipay Pay API V3 production setup

PetPack Studio is pinned to Kaipay Pay API V3. EPay V1/MD5 is retained only as
historical code and cannot be selected by the production factory.

## 1. Create the correct API key

In the Kaipay console, create or enable a **Pay API V3** key with only these
permissions:

- `order:create`
- `order:query`
- `order:refund`

The earlier “EPay 兼容密钥” is not a V3 API Key and must not be put into the V3
credential file. Complete the console's authorized-domain verification before
the real payment gate is opened.

## 2. Store the credential ring outside Git

Create the Docker secret file `kaipay_credentials_json` under the external
`PETPACK_CONFIG_ROOT`. Its exact JSON shape is:

```json
{
  "active": {
    "apiKey": "<current V3 API Key>",
    "apiSecret": "<current V3 API Secret>"
  },
  "previous": []
}
```

When rotating the secret, move the old pair into `previous` before replacing
`active`. Keep every pair until all orders created with that credential have
left their payment/refund retention window. Each order stores a non-secret
credential-version digest so webhooks, queries and refunds always use the same
secret that created it. Never paste the real key or secret into chat, Git,
Compose environment values, images, or logs.

Create a separate 32-byte application key for
`payment_notification_encryption_key`. It encrypts raw webhook evidence and
must not reuse a Kaipay API Secret.

## 3. Production environment

```text
KAIPAY_CREDENTIALS_JSON_FILE=/run/secrets/kaipay_credentials_json
PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY_FILE=/run/secrets/payment_notification_encryption_key
KAIPAY_API_BASE_URL=https://api.kaipay.cn
KAIPAY_NOTIFY_BASE_URL=https://api.heyirmy.com/api/payments/kaipay/notify
KAIPAY_RETURN_BASE_URL=https://heyirmy.com/projects/payment-return
KAIPAY_ADAPTER_VERSION=kaipay-pay-api-v3-hmac-sha256/1
KAIPAY_DEFAULT_CHANNEL=ALIPAY
KAIPAY_ALIPAY_SCENE=web
KAIPAY_WECHAT_SCENE=native
KAIPAY_REQUEST_TIMEOUT_MS=15000
KAIPAY_ALLOW_SIMULATED_PAYMENTS=false
```

`KAIPAY_SELECTED_MERCHANT_CODE` is optional. Leave it unset unless the V3
capabilities/merchant configuration explicitly requires a selected merchant
code for this account.

The browser never receives API credentials. Alipay uses `provider=alipay`,
`scene=web`, and a validated HTTPS redirect action. WeChat uses
`provider=wechat`, `scene=native`, and a QR action rendered by the website.

## 4. Public callback

Allow only:

```text
POST /api/payments/kaipay/notify/<platformOrderId>
```

The callback must preserve the raw JSON bytes and these seven headers exactly:

- `X-KPay-API-Version`
- `X-KPay-Event`
- `X-KPay-Timestamp`
- `X-KPay-Nonce`
- `X-KPay-Signature-Method`
- `X-KPay-Body-SHA256`
- `X-KPay-Signature`

The adapter verifies HMAC-SHA256, the five-minute timestamp window, body hash,
event/order/amount/currency/provider identity, then performs an authoritative V3
order query. Only both proofs together may mark an order paid. A verified paid
notification returns HTTP 204 with an empty body. GET callbacks and the old
Alipay/EPay routes remain closed.

## 5. No-charge probe and controlled acceptance

After the secret file is mounted, run from `platform/`:

```text
npm run verify:kaipay
```

It sends only the signed `GET /pay/api/v3/capabilities` request and prints only
`kaipay_v3_capabilities=ok` or a safe failure category. It confirms that the
credential can use the V3 API matrix for `alipay/web` and `wechat/native`; it
does not prove that both merchant payment channels are approved, and it does
not create an order.

Only after callback reachability and the merchant channel page are confirmed:

1. create one minimum-amount Alipay order;
2. complete payment and verify the V3 webhook plus active query;
3. replay the same webhook and prove no second run is created;
4. create one minimum-amount WeChat native order and verify the QR action;
5. execute one explicitly approved refund using a unique refund request number.

Keep purchasing and real generation disabled until all bounded checks pass.

## 6. Payment confirmation fallback

The webhook is the primary settlement path. If the customer has paid but the
webhook is delayed, the project page's **我已完成付款** action calls the
server-only `POST /api/projects/<projectId>/payment-status` route. The server
loads the frozen provider order and credential version, signs one V3 query, and
starts the workflow only when the provider response independently proves the
same order, amount, currency, provider, scene and paid state. The browser never
receives the V3 key or secret. Repeated clicks are idempotent and terminal paid
orders do not issue another provider query.

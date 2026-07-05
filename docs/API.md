# API (addy.io-compatible)

HideMyEmail exposes an [addy.io](https://addy.io/api-documentation/)-compatible
API under `/api/v1` so tools that already speak the addy.io dialect work
unmodified — most usefully **Bitwarden's username generator**.

## Authentication

Create an API key in **Settings → API Keys** (shown once — store it in your
password manager) and send it as a bearer token:

```
Authorization: Bearer hme_…
```

Keys can be revoked from the same Settings card at any time. They are stored
hashed server-side and stop working immediately when revoked, when the
account is disabled, or when the account is deleted.

## Bitwarden setup

In Bitwarden's generator, choose **Username → Forwarded email alias**:

| Field | Value |
| --- | --- |
| Service | `addy.io` |
| API access token | your `hme_…` key |
| Domain | one of your instance's domains (e.g. `hidemyemail.dev`) |
| Self-host server URL | your instance origin (e.g. `https://app.hidemyemail.dev`) |

Generated aliases forward to your **default verified destination** — set one
in the dashboard first.

## Endpoints

All endpoints require the bearer key. Errors use addy.io's
`{"message": "…"}` shape.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/api-token-details` | Validate the token; returns its name |
| GET | `/api/v1/domain-options` | Domains you can create aliases on |
| GET | `/api/v1/aliases` | List aliases (`filter[search]=` supported) |
| POST | `/api/v1/aliases` | Create an alias |
| GET | `/api/v1/aliases/:id` | Fetch one alias |
| DELETE | `/api/v1/aliases/:id` | Delete an alias (204) |
| POST | `/api/v1/active-aliases` | Activate an alias (`{"id": …}`) |
| DELETE | `/api/v1/active-aliases/:id` | Deactivate an alias (204) |

### POST /api/v1/aliases

```json
{
  "domain": "hidemyemail.dev",        // optional — defaults to the main global domain
  "description": "Website: example.com", // optional — stored as the alias label
  "format": "random_characters",      // optional — random_characters (default) | uuid | custom
  "local_part": "shop"                // required when format is "custom"
}
```

Response `201`:

```json
{
  "data": {
    "id": "42",
    "email": "x7k2p9qa@hidemyemail.dev",
    "local_part": "x7k2p9qa",
    "domain": "hidemyemail.dev",
    "active": true,
    "description": "Website: example.com",
    "emails_forwarded": 0,
    "created_at": "2026-07-04 12:00:00"
  }
}
```

(Other addy.io alias fields are present with neutral values for client
compatibility; `format: "random_words"` is not supported and returns `422`.)

Notes:

- Alias creation respects the instance's `max_total_aliases` quota (`403`
  when exceeded).
- `custom` local parts on a global domain require the admin to enable
  *custom aliases* for that domain; on your own subdomains they always work.
- Aliases created here record `source = "api"`.

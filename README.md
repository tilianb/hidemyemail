# HideMyEmail

A personal, serverless email-alias service built with **Cloudflare Workers**, **Amazon SES/SNS/S3**, and **Cloudflare D1**. It includes a modern React dashboard hosted on Cloudflare Pages and fully supports two-way reply-from-alias functionality.

## Features
- **Serverless Architecture**: Extremely cheap and scalable, running entirely on Cloudflare Workers and Amazon SES.
- **Two-Way Replies**: Not only can you receive emails to your aliases, but you can also reply *from* your alias transparently.
- **Modern Dashboard**: A clean React-based dashboard to manage aliases, domains, and view statistics.
- **Blocks & Rules**: Block unwanted senders instantly from the dashboard.
- **1-Click Unsubscribe**: Disable aliases instantly directly from your email client using `List-Unsubscribe` Quick Actions.
- **Self-Hostable**: One-command Docker container for `linux/amd64` and `linux/arm64` (see below).

## Self-host in 60 seconds

Pre-built multi-arch images live on GHCR. You still need AWS SES for the mail
pipeline (no mail server included) — everything else runs locally.

```bash
git clone https://github.com/tilianb/hidemyemail.git
cd hidemyemail/docker
cp .env.example .env

# Generate the four secrets and paste them into .env
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "DESTINATION_ENCRYPTION_KEY=$(openssl rand -base64 32)"
node ../worker/scripts/hash-password.mjs '<choose-a-password>'  # prints SALT + HASH

# Add your AWS SES creds (SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, etc.)
$EDITOR .env

docker compose pull
docker compose up -d
```

Open <http://localhost:8787>. Put Caddy/nginx/Cloudflare Tunnel in front for
TLS. See [`docker/README.md`](docker/README.md) for AWS setup, upgrades,
volumes, and troubleshooting.

## Architecture
The system consists of two main components:
1. `worker/`: A Cloudflare Worker that handles SES/SNS webhooks, processes inbound MIME fetched from S3, stores metadata in D1, and forwards mail through SES. It also provides the REST API for the dashboard.
2. `dashboard/`: A React (Vite) Single Page Application hosted on Cloudflare Pages.

### How it works
- **Inbound Email**: AWS SES receives emails for your domains, stores raw MIME in S3, and sends a signed SNS notification to the Worker. The Worker verifies the SNS signature and exact topic ARN, fetches the raw MIME, rewrites headers, and forwards it to your real email.
- **Outbound (Reply)**: When you reply to a forwarded email, it goes through Amazon SES. A webhook catches the SES bounce/delivery, or the Worker intercepts the outbound send, rewriting the `From` address back to your alias before it reaches the recipient.

## AWS SES & SNS Setup

To support outbound replies and monitor email health, you need an Amazon SES account and an SNS topic for bounce/delivery notifications.

1. **Amazon SES Setup**:
   - Verify your sending domain in Amazon SES.
   - Configure SES to publish bounce and delivery events to an Amazon SNS topic.
   - (Optional) Request production access if you are in the SES sandbox to send emails to unverified addresses.

2. **Amazon SNS Webhooks**:
   - Create HTTPS subscriptions for your SNS topics pointing to your worker webhooks:
     - `https://<worker-domain>/api/ses/inbound`
     - `https://<worker-domain>/api/ses/notification`
   - Do not add shared-secret query parameters. The Worker verifies AWS SNS signatures and the exact configured topic ARNs.

3. **Confirm Subscription**:
   - When you create the SNS subscription, SNS will send a `SubscriptionConfirmation` message.
   - Check your worker's logs (e.g., using `wrangler tail`) to find the printed `SubscribeURL`.
   - Open that URL in your browser to manually confirm the SNS subscription.

4. **Security & Validation**:
   - Set `SNS_INBOUND_TOPIC_ARN` and `SNS_ALLOWED_TOPIC_ARN` in each Worker environment to the exact ARNs for that environment. Preview/dev should use their own topic ARNs rather than an `allowed_topic` URL override.

## Documentation
- [Service Design & Architecture Spec](docs/superpowers/specs/2026-05-24-hidemyemail-alias-service-design.md)
- [Implementation Plan](docs/superpowers/plans/2026-05-24-hidemyemail-alias-service.md)
- [Deployment Guide](docs/DEPLOY.md)

## Development Setup

The project uses GitHub Actions for Continuous Integration. On every push and pull request, the CI pipeline automatically runs the worker test suite and builds the dashboard to ensure code stability.

### Worker (Backend)
Navigate to the `worker` directory to develop and test the API and Email logic:
```bash
cd worker
npm install
npm test             # Run the worker test suite
npx wrangler dev     # Run local worker (handles API and email)
```

### Dashboard (Frontend)
Navigate to the `dashboard` directory to develop the React UI:
```bash
cd dashboard
npm install
npm run dev          # Run the dashboard against the local worker
```

## License
This project is licensed under the [MIT License](LICENSE).

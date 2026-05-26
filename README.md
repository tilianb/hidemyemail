# HideMyEmail

A personal, serverless email-alias service built with **Cloudflare Email Routing**, **Cloudflare Workers**, **Amazon SES**, and **Cloudflare D1**. It includes a modern React dashboard hosted on Cloudflare Pages and fully supports two-way reply-from-alias functionality.

## Features
- **Serverless Architecture**: Extremely cheap and scalable, running entirely on Cloudflare Workers and Amazon SES.
- **Two-Way Replies**: Not only can you receive emails to your aliases, but you can also reply *from* your alias transparently.
- **Modern Dashboard**: A clean React-based dashboard to manage aliases, domains, and view statistics.
- **Blocks & Rules**: Block unwanted senders instantly from the dashboard.
- **1-Click Unsubscribe**: Disable aliases instantly directly from your email client using `List-Unsubscribe` Quick Actions.

## Architecture
The system consists of two main components:
1. `worker/`: A Cloudflare Worker that handles incoming emails via Cloudflare Email Routing, processes them, stores metadata in D1, and forwards them. It also provides the REST API for the dashboard.
2. `dashboard/`: A React (Vite) Single Page Application hosted on Cloudflare Pages.

### How it works
- **Inbound Email**: Cloudflare Email Routing catches emails to your domains and triggers the Worker. The Worker looks up the alias, rewrites headers, and forwards it to your real email.
- **Outbound (Reply)**: When you reply to a forwarded email, it goes through Amazon SES. A webhook catches the SES bounce/delivery, or the Worker intercepts the outbound send, rewriting the `From` address back to your alias before it reaches the recipient.

## AWS SES & SNS Setup

To support outbound replies and monitor email health, you need an Amazon SES account and an SNS topic for bounce/delivery notifications.

1. **Amazon SES Setup**:
   - Verify your sending domain in Amazon SES.
   - Configure SES to publish bounce and delivery events to an Amazon SNS topic.
   - (Optional) Request production access if you are in the SES sandbox to send emails to unverified addresses.

2. **Amazon SNS Webhook**:
   - Create an HTTPS subscription for your SNS topic pointing to your worker's webhook:
     `https://<worker-domain>/api/ses/notification?secret=<your_sns_secret>`
     *(Note: adjust `/api/ses/notification` if your routes are mounted differently. By default, it may be `/api/ses/notification` or `/ses/notification` depending on your worker router).*
   - Set a secure random string for `SNS_SECRET` in your worker's `.dev.vars` and Cloudflare environment secrets.

3. **Confirm Subscription**:
   - When you create the SNS subscription, SNS will send a `SubscriptionConfirmation` message.
   - Check your worker's logs (e.g., using `wrangler tail`) to find the printed `SubscribeURL`.
   - Open that URL in your browser to manually confirm the SNS subscription.

4. **Security & Validation**:
   - For extra security, set `SNS_ALLOWED_TOPIC_ARN` in your worker's environment variables to the exact ARN of your SNS topic. The webhook will reject payloads from other topics.

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

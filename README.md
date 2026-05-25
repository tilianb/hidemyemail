# HideMyEmail

A personal, serverless email-alias service built with **Cloudflare Email Routing**, **Cloudflare Workers**, **Amazon SES**, and **Cloudflare D1**. It includes a modern React dashboard hosted on Cloudflare Pages and fully supports two-way reply-from-alias functionality.

## Features
- **Serverless Architecture**: Extremely cheap and scalable, running entirely on Cloudflare Workers and Amazon SES.
- **Two-Way Replies**: Not only can you receive emails to your aliases, but you can also reply *from* your alias transparently.
- **Modern Dashboard**: A clean React-based dashboard to manage aliases, domains, and view statistics.
- **Blocks & Rules**: Block unwanted senders instantly from the dashboard.

## Architecture
The system consists of two main components:
1. `worker/`: A Cloudflare Worker that handles incoming emails via Cloudflare Email Routing, processes them, stores metadata in D1, and forwards them. It also provides the REST API for the dashboard.
2. `dashboard/`: A React (Vite) Single Page Application hosted on Cloudflare Pages.

### How it works
- **Inbound Email**: Cloudflare Email Routing catches emails to your domains and triggers the Worker. The Worker looks up the alias, rewrites headers, and forwards it to your real email.
- **Outbound (Reply)**: When you reply to a forwarded email, it goes through Amazon SES. A webhook catches the SES bounce/delivery, or the Worker intercepts the outbound send, rewriting the `From` address back to your alias before it reaches the recipient.

## Documentation
- [Service Design & Architecture Spec](docs/superpowers/specs/2026-05-24-hidemyemail-alias-service-design.md)
- [Implementation Plan](docs/superpowers/plans/2026-05-24-hidemyemail-alias-service.md)
- [Deployment Guide](docs/DEPLOY.md)

## Development Setup

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

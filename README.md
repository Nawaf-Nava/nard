# NARD

NARD is a transparent visitor-information tool. Opening a private visit link records one technical visit event for that browser tab and displays it in the link owner's dashboard.

## What is recorded

- Approximate device class, operating system, and browser family from the browser user-agent.
- Browser language, timezone, and coarse screen-size class.
- Visit timestamp.
- Country/city only when the hosting provider supplies trusted location headers. This is approximate and may be unavailable.

NARD does not store raw IP addresses or full user-agent strings in its visit records. It does not request GPS permission, collect precise coordinates, read device files or contacts, or continuously track visitors. The visit page discloses the collection before the event is sent.

## Requirements

- Node.js 20 or newer

## Run locally

    npm install
    npm start

Open http://localhost:3000/admin.

## Configuration

- PORT (default: 3000)
- SESSION_TTL_MINUTES (default: 30, maximum: 60)
- BASE_URL (optional public base URL used when generating visit links)

## API

- POST /api/sessions creates an owner session and a private visit link.
- POST /api/sessions/:shareToken/visit records one visit event.
- GET /api/sessions/:ownerToken/analytics returns visit records and aggregate counts.
- DELETE /api/sessions/:ownerToken revokes the link and deletes its in-memory session.

## Important deployment limitation

This branch currently stores sessions and visit records in process memory. Restarting the server deletes them, and multiple server instances do not share data. It is a development/MVP implementation, **not production-ready** until a persistent database, deployment-specific proxy/header validation, admin authentication policy, retention controls, and end-to-end deployment tests are configured.

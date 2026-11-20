# GeoLink

A consent-based location sharing web app. A person opens a private invitation link, reviews the request, and explicitly grants browser location permission before their location is shared.

## Privacy model

- A phone number cannot reveal a person's live location. GeoLink does not perform phone-number tracking.
- Location is shared only after the visitor presses **Share my location** and grants the browser permission.
- Each session has separate owner and participant tokens.
- Sessions expire automatically after 30 minutes and can be revoked by the owner.
- Location data is held in server memory only; it is not written to a database.
- Use HTTPS in production. Browser geolocation is unavailable on ordinary insecure HTTP pages.

## Requirements

- Node.js 20 or newer

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. For testing geolocation from another device, deploy behind HTTPS.

## Configuration

- `PORT` (default: `3000`)
- `SESSION_TTL_MINUTES` (default: `30`, maximum: `60`)
- `BASE_URL` (optional public base URL used when generating invitation links)

## API

- `POST /api/sessions` creates a session and returns an owner token and participant link.
- `POST /api/sessions/:shareToken/location` stores a participant's location after consent.
- `GET /api/sessions/:ownerToken` returns the latest location for the owner.
- `DELETE /api/sessions/:ownerToken` revokes the session.

This is an MVP. In-memory sessions are cleared when the server restarts and are not suitable for multi-instance hosting without a shared session store.
# Nail Studio Backend

Node/Express backend for a small nail salon assistant:

- REST API for services, slots, bookings, and admin views
- SQLite database (`salon.db`)
- AI receptionist endpoint (`POST /chat`) using OpenAI tools to:
  - suggest services
  - find available slots
  - create, cancel, and reschedule appointments

## Prerequisites

- Node.js 18+ (recommended)
- npm

## Setup

From the `backend/` folder:

```bash
npm install
cp .env.example .env
```

Edit `.env` and set:

- `OPENAI_API_KEY` – your OpenAI API key
- `JWT_SECRET` – any random string (used for admin auth if re-enabled)
- `EMAIL_USER` / `EMAIL_PASS` – SMTP credentials if you want booking emails (optional)

> **Important:** Do **not** commit `.env` or `salon.db`. Both are already in `.gitignore`.

## Running the server

```bash
cd backend
npm start
```

The server starts on `http://localhost:3001`.

Frontend files are served from `backend/public/`, so you can open:

- `http://localhost:3001/` – main site
- `http://localhost:3001/reservation.html` – booking page
- `http://localhost:3001/admin.html` – admin reservations table

## Admin reservations UI

- `GET /appointments` populates the admin table.
- The Date column is sortable (click header), default sort is newest first.
- Admin actions:
  - Cancel appointment: calls `PATCH /appointments/:id` with `{ "status": "cancelled" }`.

> Note: In this demo, admin endpoints are **not** protected. If you deploy this publicly, you should re‑enable JWT auth around admin routes.

## AI receptionist (`POST /chat`)

Endpoint: `POST /chat`

Body (simplified):

```json
{
  "message": "I'd like a classic manicure tomorrow at 14:00",
  "messages": [],
  "sessionId": "any-id",
  "lang": "en"
}
```

Behavior:

- Uses a system prompt tailored for a salon receptionist.
- Uses OpenAI tools:
  - `parse_date` – ask the server for today’s date and timezone
  - `get_available_slots` – check free slots for a given service/date
  - `create_booking` – insert a new appointment
  - `cancel_appointment` – cancel an existing appointment after verifying:
    - service
    - date
    - time
    - client name
    - client email
  - `change_appointment` – move an existing appointment to a new date/time (and optional service)

### Booking flow

1. Collects: service, date, time, name, email.
2. Calls `get_available_slots` to verify the slot.
3. On confirmation, calls `create_booking`.
4. Responds: “I booked the appointment for you! Anything else I can help?”

### Cancel / change flow

1. Collects: service, appointment date, time, client name, client email.
2. For cancel:
   - Calls `cancel_appointment`.
3. For change:
   - Collects new date/time (and optional new service).
   - Calls `change_appointment`.

If input doesn’t uniquely identify an appointment (e.g. wrong date/time/service), the backend returns “Appointment not found”.

## Security notes (for public GitHub)

- **Never** commit:
  - `.env` – contains secrets
  - `salon.db` – contains real client data
- This repository is safe to share as long as:
  - `.env` and `salon.db` stay untracked
  - Real keys/passwords are only in your local `.env`

If you plan to deploy this:

- Lock down admin routes (`/appointments`, `/admin/appointments`, `PATCH /appointments/:id`) with real auth.
- Restrict CORS origins instead of `app.use(cors())` with defaults.


require("dotenv").config();

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const apiKey = process.env.OPENAI_API_KEY;

const express = require("express");
const cors = require("cors");
const path = require("path");
const OpenAI = require("openai");
const nodemailer = require("nodemailer");

const db = require("./database");
const { servicesPl, servicesEn } = require("./services");
const generateSlots = require("./slots");

const app = express();

// Seed services table so appointments FK and /available-slots DB lookup work
function seedServices() {
  const list = servicesEn; // same ids as servicesPl
  list.forEach((s) => {
    const name = s.name || servicesPl.find((p) => p.id === s.id)?.name_en || s.id;
    const price = (s.price_eur != null ? s.price_eur + " €" : "");
    db.run(
      "INSERT OR REPLACE INTO services (id, name, duration_minutes, price) VALUES (?, ?, ?, ?)",
      [s.id, name, s.duration_min || 30, price],
      (err) => { if (err) console.error("Seed service:", err); }
    );
  });
}
// Run after DB has created tables (database.js uses db.serialize for schema)
setTimeout(seedServices, 100);

// Seed default admin if no admins exist (username: admin, password: admin)
function seedAdmin() {
  db.get("SELECT COUNT(*) AS c FROM admins", (err, row) => {
    if (err || (row && row.c > 0)) return;
    bcrypt.hash("admin", 10, (err, hash) => {
      if (err) { console.error("Seed admin hash error:", err); return; }
      db.run("INSERT INTO admins (username, password_hash) VALUES (?, ?)", ["admin", hash], (err) => {
        if (err) console.error("Seed admin insert:", err);
        else console.log("Default admin created: username 'admin', password 'admin'");
      });
    });
  });
}
setTimeout(seedAdmin, 200);

// Admin auth: JWT (use JWT_SECRET in .env; dev fallback if missing)
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

function requireAdminToken(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return res.status(401).json({ error: "Unauthorized. Please sign in." });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized. Please sign in." });
  }
}

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/** Normalize time to HH:mm */
function normTime(t) {
  const [h, m] = String(t).split(":").map(Number);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Normalize service_id so "Classic manicure" or "classic manicure" matches DB id "classic-manicure" */
function normalizeServiceId(service_id) {
  const s = String(service_id || "").trim().toLowerCase();
  return s.replace(/\s+/g, "-");
}

/**
 * Create a booking: resolve with success message or reject with error string.
 * Uses: name, email, service_id, date, start_time (end_time computed from service duration).
 */
function createBooking(data) {
  return new Promise((resolve, reject) => {
    const { name, email, service_id, date, start_time } = data;
    const serviceIdNorm = normalizeServiceId(service_id);
    const startNorm = normTime(start_time);

    db.get(
      "SELECT duration_minutes FROM services WHERE id = ?",
      [serviceIdNorm],
      (err, service) => {
        if (err) return reject("Failed to load service");
        if (!service) return reject("Service not found");

        const duration = service.duration_minutes;
        const startDate = new Date(`2000-01-01T${startNorm}`);
        startDate.setMinutes(startDate.getMinutes() + duration);
        const end_time = `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`;

        db.get(
          `SELECT * FROM appointments
           WHERE date = ? AND start_time < ? AND end_time > ?`,
          [date, end_time, startNorm],
          (err, row) => {
            if (err) return reject("Failed to check availability");
            if (row) return reject("Slot already booked");

            db.get("SELECT id, name FROM clients WHERE email = ?", [email], (err, client) => {
              if (err) return reject("Failed to lookup client");

              const insertAppointment = (client_id) => {
                db.run(
                  `INSERT INTO appointments (service_id, client_id, date, start_time, end_time, status)
                   VALUES (?, ?, ?, ?, ?, 'confirmed')`,
                  [serviceIdNorm, client_id, date, startNorm, end_time],
                  function (err) {
                    if (err) reject(err);
                    else resolve({ success: true, end_time });
                  }
                );
              };

              if (client) {
                const trimmedName = String(name || "").trim();
                if (trimmedName && client.name !== trimmedName) {
                  db.run(
                    "UPDATE clients SET name = ? WHERE id = ?",
                    [trimmedName, client.id],
                    function (updateErr) {
                      if (updateErr) console.error("Update client name error:", updateErr);
                      insertAppointment(client.id);
                    }
                  );
                } else {
                  insertAppointment(client.id);
                }
              } else {
                db.run(
                  "INSERT INTO clients (name, email) VALUES (?, ?)",
                  [name, email],
                  function (err) {
                    if (err) return reject("Failed to create client");
                    insertAppointment(this.lastID);
                  }
                );
              }
            });
          }
        );
      }
    );
  });
}

/**
 * Get available time slots for a service on a date. Returns a Promise of [{ start, end }, ...].
 */
async function getAvailableSlots(service_id, date) {
  return new Promise((resolve, reject) => {
    const serviceIdNorm = normalizeServiceId(service_id);
    db.get(
      "SELECT duration_minutes FROM services WHERE id = ?",
      [serviceIdNorm],
      (err, service) => {
        if (err) return reject("Failed to load service");
        if (!service) return reject("Service not found");

        const duration = service.duration_minutes;
        const startTimes = generateSlots(duration);
        const allSlots = startTimes.map((start) => {
          const [h, m] = start.split(":").map(Number);
          const endMinutes = h * 60 + m + duration;
          const end = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
          return { start, end };
        });

        db.all(
          "SELECT start_time, end_time FROM appointments WHERE date = ?",
          [date],
          (err, appointments) => {
            if (err) return reject("Failed to load appointments");
            const list = appointments || [];
            const available = allSlots.filter((slot) =>
              !list.some((app) => app.start_time < slot.end && app.end_time > slot.start)
            );
            resolve(available);
          }
        );
      }
    );
  });
}

/**
 * Find a single appointment for a client by service/date/time/email.
 * Uses normalized service_id and HH:mm time.
 */
async function findAppointmentForClient({ service_id, date, start_time, email }) {
  return new Promise((resolve, reject) => {
    const serviceIdNorm = normalizeServiceId(service_id);
    const startNorm = normTime(start_time);
    const dateTrimmed = String(date || "").trim();
    const emailTrimmed = String(email || "").trim();

    if (!dateTrimmed || !emailTrimmed) {
      return reject("Missing date or email");
    }

    db.get(
      `SELECT a.id, a.date, a.start_time, a.end_time, a.status,
              s.id AS service_id, s.name AS service_name,
              c.id AS client_id, c.name AS client_name, c.email
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       JOIN clients c ON c.id = a.client_id
       WHERE a.date = ?
         AND a.start_time = ?
         AND c.email = ?
         AND a.service_id = ?`,
      [dateTrimmed, startNorm, emailTrimmed, serviceIdNorm],
      (err, row) => {
        if (err) return reject("Failed to lookup appointment");
        if (!row) return reject("Appointment not found");
        resolve(row);
      }
    );
  });
}

/**
 * Cancel an appointment for a client after verification.
 */
async function cancelAppointmentForClient(args) {
  const appt = await findAppointmentForClient(args);
  if (appt.status === "cancelled") {
    return { success: true, message: "Appointment is already cancelled." };
  }
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE appointments SET status = 'cancelled' WHERE id = ?",
      [appt.id],
      function (err) {
        if (err) return reject("Failed to cancel appointment");
        if (this.changes === 0) return reject("Appointment not found");
        resolve({ success: true });
      }
    );
  });
}

/**
 * Change an existing appointment to a new date/time (and optionally service).
 */
async function changeAppointmentForClient(args) {
  const appt = await findAppointmentForClient({
    service_id: args.service_id,
    date: args.date,
    start_time: args.start_time,
    email: args.email,
  });

  const targetServiceId = normalizeServiceId(args.new_service_id || args.service_id);
  const newDate = String(args.new_date || args.date || "").trim();
  const newStartNorm = normTime(args.new_start_time || args.start_time);

  if (!newDate) {
    throw "Missing new date";
  }

  const duration = await new Promise((resolve, reject) => {
    db.get(
      "SELECT duration_minutes FROM services WHERE id = ?",
      [targetServiceId],
      (err, service) => {
        if (err) return reject("Failed to load service");
        if (!service) return reject("Service not found");
        resolve(service.duration_minutes);
      }
    );
  });

  const [h, m] = newStartNorm.split(":").map(Number);
  const endMinutes = h * 60 + m + duration;
  const newEnd = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;

  const conflict = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM appointments
       WHERE date = ?
         AND start_time < ?
         AND end_time > ?
         AND id != ?`,
      [newDate, newEnd, newStartNorm, appt.id],
      (err, row) => {
        if (err) return reject("Failed to check availability");
        resolve(!!row);
      }
    );
  });
  if (conflict) {
    throw "New time slot is already booked";
  }

  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE appointments SET date = ?, start_time = ?, end_time = ?, service_id = ? WHERE id = ?",
      [newDate, newStartNorm, newEnd, targetServiceId, appt.id],
      function (err) {
        if (err) return reject("Failed to update appointment");
        if (this.changes === 0) return reject("Appointment not found");
        resolve({
          success: true,
          date: newDate,
          start_time: newStartNorm,
          end_time: newEnd,
          service_id: targetServiceId,
        });
      }
    );
  });
}

const openaiClient = new OpenAI({ apiKey });
const sessions = new Map(); // sessionId -> messages[]

function buildSystemPrompt(lang) {
  const langInstruction =
    lang === "pl"
      ? "Odpowiadaj wyłącznie po polsku."
      : "Respond in English only.";
  const today = new Date();
  const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  const serviceLines = servicesEn
    .map((s) => {
      let line = `- ${s.name} (id: ${s.id}): ${s.description} Price: ${s.price_eur} €. Duration: ${s.duration_min} min.`;
      if (s.includes) line += ` Includes: ${s.includes}.`;
      if (s.note) line += ` Note: ${s.note}.`;
      if (s.addons && s.addons.length > 0) {
        line += ` Add-ons: ${s.addons.map((a) => a.label).join(", ")}.`;
      }
      return line;
    })
    .join("\n");

  return `You are an AI receptionist for a nail salon. Stay in character as a friendly receptionist at all times.

RULES FOR TALKING TO THE CLIENT:
- Speak naturally and warmly. Never show placeholders, instructions, or format hints to the user (e.g. never write "[insert tomorrow's date]", "YYYY-MM-DD", or "[your name]" in your message).
- When mentioning dates to the user, use natural language: "tomorrow", "Sunday the 2nd", "March 5th", etc. Only use YYYY-MM-DD when calling tools (get_available_slots, create_booking).
- When the user says they want a date (e.g. "tomorrow", "next Monday"), convert it to YYYY-MM-DD in tool calls using today's date.

Today's date is ${todayStr}
Timezone: Europe/Warsaw

If the user specifies an explicit calendar date (e.g. "6 March"), use that date itself as the source of truth when calling tools.
If the weekday conflicts with the date (e.g. "Sunday 6 March" but 6 March is a Monday), trust the date, not the weekday.

You must collect:
- service (use service id from the list below in tool calls)
- date (convert user phrases like "tomorrow" to YYYY-MM-DD for tool calls)
- time (start time)
- client name
- client email

Ask for missing information step by step. Ask at most 1–2 questions at a time.
Do not invent data. When the client gives information, repeat it back if needed to confirm.

When the user has selected a date and service, call get_available_slots(service_id, date) to check availability before suggesting or accepting a time.

If the requested time is unavailable, call get_available_slots again and suggest 2–3 closest available options.

After you have all details, summarize the booking (date, time, service, name) and ask the user to confirm (e.g. "Should I book this for you?"). When the user confirms with a positive answer (e.g. "yes", "perfect", "sure", "book it", "confirm", "sounds good", "please do"), call create_booking immediately with the collected details. Do not ask "How can I help you?" or start over after a confirmation—complete the booking.

If a user wants to cancel or modify an appointment, you must first collect:
- service name (use service id from the list below in tool calls)
- appointment date
- appointment time
- client name
- client email

Only after you have all of these, call the appropriate tool:
- cancel_appointment to cancel
- change_appointment to reschedule

Confirm the details back to the client before calling these tools.

${langInstruction}

SERVICES (use these ids in create_booking and get_available_slots):
${serviceLines}
`;
}

// Detect if user message is likely Polish (has Polish chars or common Polish words)
function isPolish(text) {
  const polishChars = /[ąćęłńóśźż]/i;
  const polishWords = /\b(manicure|klasyczny|żelowy|hybrydowy|szybkie|odświeżenie|olejek|lakier|skórek|kształtu|cenie|prezencie|obiadową|paznokcie|usług|jakie|ile|koszt|czas|trwa)\b/i;
  return polishChars.test(text) || polishWords.test(text);
}

function formatServiceReply(service, lang) {
  const isPl = lang === "pl";
  const name = isPl ? service.name_pl : service.name_en;
  const desc = isPl ? service.description_pl : service.description_en;
  const price = `${service.price_eur} €`;
  const duration = `${service.duration_min} min`;
  let parts = [desc, `${isPl ? "Cena" : "Price"}: ${price}`, `${isPl ? "Czas" : "Duration"}: ${duration}`];
  if (service.includes_pl != null || service.includes_en != null) {
    parts.push(isPl ? service.includes_pl : service.includes_en);
  }
  if (service.note_pl != null || service.note_en != null) {
    parts.push(isPl ? service.note_pl : service.note_en);
  }
  if (service.addons && service.addons.length > 0) {
    const addonList = service.addons.map((a) => isPl ? a.label_pl : a.label_en).join(", ");
    parts.push(isPl ? "Dodatki: " + addonList : "Add-ons: " + addonList);
  }
  return `${name}. ${parts.join(" ")}`;
}

function formatServiceReplyEn(service) {
  const price = `${service.price_eur} €`;
  const duration = `${service.duration_min} min`;
  const parts = [
    service.description,
    `Price: ${price}`,
    `Duration: ${duration}`
  ];
  if (service.includes) parts.push(service.includes);
  if (service.note) parts.push(service.note);
  if (service.addons && service.addons.length > 0) {
    parts.push("Add-ons: " + service.addons.map((a) => a.label).join(", "));
  }
  return `${service.name}. ${parts.join(" ")}`;
}

function findService(userMessage, lang) {
  const lower = userMessage.toLowerCase().trim();
  const list = lang === "pl" ? servicesPl : servicesEn;

  if (lang === "pl") {
    for (const s of list) {
      if (lower.includes(s.id.replace(/-/g, " "))) return s;
      if (lower.includes(s.name_en.toLowerCase())) return s;
      if (lower.includes(s.name_pl.toLowerCase())) return s;
      const nameWordsPl = s.name_pl.toLowerCase().split(/\s+/);
      const nameWordsEn = s.name_en.toLowerCase().split(/\s+/);
      for (const w of nameWordsPl) {
        if (w.length > 2 && lower.includes(w)) return s;
      }
      for (const w of nameWordsEn) {
        if (w.length > 2 && lower.includes(w)) return s;
      }
      for (const tag of s.tags) {
        if (lower.includes(tag)) return s;
      }
    }
  } else {
    for (const s of list) {
      if (lower.includes(s.id.replace(/-/g, " "))) return s;
      if (lower.includes(s.name.toLowerCase())) return s;
      const nameWords = s.name.toLowerCase().split(/\s+/);
      for (const w of nameWords) {
        if (w.length > 2 && lower.includes(w)) return s;
      }
      for (const tag of s.tags) {
        if (lower.includes(tag)) return s;
      }
    }
  }
  return null;
}

app.get("/services", (req, res) => {
  const lang = req.query.lang || "en";

  if (lang === "pl") {
    return res.json(
      servicesPl.map((s) => ({
        ...s,
        name: s.name_pl,
        price: s.price_eur != null ? s.price_eur + " €" : ""
      }))
    );
  }

  res.json(
    servicesEn.map((s) => ({
      ...s,
      price: s.price_eur != null ? s.price_eur + " €" : ""
    }))
  );
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = (username != null && typeof username === "string") ? username.trim() : "";
  const p = (password != null && typeof password === "string") ? password : "";

  if (!u || !p) {
    return res.status(401).json({ success: false, error: "Invalid credentials" });
  }

  db.get(
    "SELECT * FROM admins WHERE username = ?",
    [u],
    async (err, admin) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Database error." });
      }
      if (!admin) {
        return res.status(401).json({ success: false, error: "Invalid credentials" });
      }

      let match;
      try {
        match = await bcrypt.compare(p, admin.password_hash);
      } catch (compareErr) {
        console.error(compareErr);
        return res.status(500).json({ error: "Invalid credentials" });
      }
      if (!match) {
        return res.status(401).json({ success: false, error: "Invalid credentials" });
      }

      const token = jwt.sign(
        { adminId: admin.id },
        JWT_SECRET,
        { expiresIn: "2h" }
      );
      res.json({ success: true, token });
    }
  );
});

app.get("/appointments", (req, res) => {
  db.all(
    `SELECT a.id, a.date, a.start_time, a.end_time, a.service_id, a.status,
            s.name AS service_name,
            c.name AS client_name, c.email AS client_email
     FROM appointments a
     LEFT JOIN services s ON s.id = a.service_id
     LEFT JOIN clients c ON c.id = a.client_id
     ORDER BY a.date ASC, a.start_time ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to load appointments." });
      }
      res.json(Array.isArray(rows) ? rows : []);
    }
  );
});

app.get("/admin/appointments", (req, res) => {
  db.all(
    `SELECT
      appointments.id,
      appointments.date,
      appointments.start_time,
      appointments.end_time,
      appointments.status,
      services.name AS service_name,
      clients.name AS client_name,
      clients.email AS client_email
    FROM appointments
    JOIN services ON appointments.service_id = services.id
    JOIN clients ON appointments.client_id = clients.id
    ORDER BY appointments.date ASC, appointments.start_time ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to load appointments." });
      }
      res.json(Array.isArray(rows) ? rows : []);
    }
  );
});

app.patch("/appointments/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ error: "Invalid appointment id." });
  }
  const { status } = req.body || {};
  const allowed = ["confirmed", "cancelled", "completed"];
  if (typeof status !== "string" || !allowed.includes(status.trim())) {
    return res.status(400).json({ error: "Invalid status. Use: confirmed, cancelled, completed." });
  }
  db.run(
    "UPDATE appointments SET status = ? WHERE id = ?",
    [status.trim(), id],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to update appointment." });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Appointment not found." });
      }
      res.json({ success: true });
    }
  );
});

app.post("/chat", async (req, res) => {
  const body = req.body || {};
  const currentMessage = (body.message != null ? String(body.message) : "").trim();
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const langParam = body.lang === "pl" || body.lang === "en" ? body.lang : null;
  const sessionId = body.sessionId != null ? String(body.sessionId) : "default";

  const lang =
    langParam != null
      ? langParam
      : currentMessage && isPolish(currentMessage)
        ? "pl"
        : "en";

  const defaultReply =
    lang === "pl" ? "Jak mogę pomóc?" : "How can I help you?";
  const errorReply =
    lang === "pl"
      ? "Wystąpił błąd. Spróbuj ponownie."
      : "Server error. Please try again.";

  if (!currentMessage) {
    return res.json({ reply: defaultReply, sessionId });
  }

  try {
    let history;
    if (sessionId && sessions.has(sessionId)) {
      history = sessions.get(sessionId);
    } else {
      history = rawMessages
        .filter(
          (m) =>
            m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
        )
        .map((m) => ({ role: m.role, content: m.content.trim() }))
        .filter((m) => m.content.length > 0);
      if (sessionId) sessions.set(sessionId, [...history]);
    }

    history.push({ role: "user", content: currentMessage });
    const recentHistory = history.slice(-12);

    const today = new Date().toISOString().split("T")[0];

    const chatTools = [
      {
        type: "function",
        function: {
          name: "parse_date",
          description: "Get normalized date information (today's date and timezone). Use this when you need the current date.",
          parameters: {
            type: "object",
            properties: {},
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_available_slots",
          description: "Get available time slots for a service on a specific date",
          parameters: {
            type: "object",
            properties: {
              service_id: { type: "string" },
              date: { type: "string" }
            },
            required: ["service_id", "date"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_booking",
          description: "Create a booking in the salon system",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              service_id: { type: "string" },
              date: { type: "string" },
              start_time: { type: "string" }
            },
            required: ["name", "email", "service_id", "date", "start_time"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "cancel_appointment",
          description: "Cancel an existing appointment after verifying client details.",
          parameters: {
            type: "object",
            properties: {
              service_id: { type: "string" },
              date: { type: "string" },
              start_time: { type: "string" },
              name: { type: "string" },
              email: { type: "string" }
            },
            required: ["service_id", "date", "start_time", "email"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "change_appointment",
          description: "Reschedule an existing appointment to a new date/time (and optionally service).",
          parameters: {
            type: "object",
            properties: {
              service_id: { type: "string" },
              date: { type: "string" },
              start_time: { type: "string" },
              name: { type: "string" },
              email: { type: "string" },
              new_service_id: { type: "string" },
              new_date: { type: "string" },
              new_start_time: { type: "string" }
            },
            required: ["service_id", "date", "start_time", "email", "new_date", "new_start_time"]
          }
        }
      }
    ];

    let response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPrompt(lang) },
        ...recentHistory,
      ],
      temperature: 0.7,
      tools: chatTools,
      tool_choice: "auto",
    });

    const message = response.choices?.[0]?.message;
    let reply = message?.content?.trim() || defaultReply;

    if (message?.tool_calls?.length) {
      const toolCall = message.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments || "{}");

      if (toolCall.function?.name === "parse_date") {
        const now = new Date();
        const todayIso = now.toISOString().split("T")[0];
        const toolPayload = { today: todayIso, timezone: "Europe/Warsaw" };
        const secondResponse = await openaiClient.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: buildSystemPrompt(lang) },
            ...recentHistory,
            message,
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolPayload),
            },
          ],
          temperature: 0.7,
        });
        reply = secondResponse.choices?.[0]?.message?.content?.trim() || JSON.stringify(toolPayload);
        history.push({ role: "assistant", content: reply });
        if (sessionId) sessions.set(sessionId, history);
        return res.json({ reply, sessionId });
      }

      if (toolCall.function?.name === "get_available_slots") {
        const slots = await getAvailableSlots(args.service_id, args.date);
        const secondResponse = await openaiClient.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: buildSystemPrompt(lang) },
            ...recentHistory,
            message,
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(slots),
            },
          ],
          temperature: 0.7,
        });
        reply = secondResponse.choices?.[0]?.message?.content?.trim() || JSON.stringify(slots);
        history.push({ role: "assistant", content: reply });
        if (sessionId) sessions.set(sessionId, history);
        return res.json({ reply, sessionId });
      }

      if (toolCall.function?.name === "create_booking") {
        try {
          const result = await createBooking({
            name: String(args.name || "").trim(),
            email: String(args.email || "").trim(),
            service_id: String(args.service_id || "").trim(),
            date: String(args.date || "").trim(),
            start_time: String(args.start_time || "").trim(),
          });
          const successReply = lang === "pl"
            ? "Zarezerwowałam wizytę dla Ciebie! Mogę w czymś jeszcze pomóc?"
            : "I booked the appointment for you! Anything else I can help?";
          history.push({ role: "assistant", content: successReply });
          if (sessionId) sessions.set(sessionId, history);
          return res.json({ reply: successReply, sessionId });
        } catch (error) {
          const slots = await getAvailableSlots(args.service_id, args.date);
          const suggestion = slots.slice(0, 3);
          reply = `That time is already booked 😔\nAvailable times:\n${suggestion.map((s) => `${s.start} - ${s.end}`).join("\n")}`;
          history.push({ role: "assistant", content: reply });
          if (sessionId) sessions.set(sessionId, history);
          return res.json({ reply, sessionId });
        }
      }

      if (toolCall.function?.name === "cancel_appointment") {
        try {
          await cancelAppointmentForClient({
            service_id: args.service_id,
            date: args.date,
            start_time: args.start_time,
            email: args.email,
            name: args.name,
          });
          reply = lang === "pl"
            ? "Anulowałam Twoją wizytę. Mogę w czymś jeszcze pomóc?"
            : "I’ve cancelled your appointment. Anything else I can help with?";
          history.push({ role: "assistant", content: reply });
          if (sessionId) sessions.set(sessionId, history);
          return res.json({ reply, sessionId });
        } catch (error) {
          const msg = (error && error.message) || String(error);
          reply = msg;
          history.push({ role: "assistant", content: reply });
          if (sessionId) sessions.set(sessionId, history);
          return res.json({ reply, sessionId });
        }
      }

      if (toolCall.function?.name === "change_appointment") {
        try {
          await changeAppointmentForClient({
            service_id: args.service_id,
            date: args.date,
            start_time: args.start_time,
            email: args.email,
            name: args.name,
            new_service_id: args.new_service_id || args.service_id,
            new_date: args.new_date,
            new_start_time: args.new_start_time,
          });
          reply = lang === "pl"
            ? "Zaktualizowałam termin Twojej wizyty. Mogę w czymś jeszcze pomóc?"
            : "I’ve updated your appointment. Anything else I can help with?";
          history.push({ role: "assistant", content: reply });
          if (sessionId) sessions.set(sessionId, history);
          return res.json({ reply, sessionId });
        } catch (error) {
          const msg = (error && error.message) || String(error);
          reply = msg;
          history.push({ role: "assistant", content: reply });
          if (sessionId) sessions.set(sessionId, history);
          return res.json({ reply, sessionId });
        }
      }
    }

    history.push({ role: "assistant", content: reply });
    if (sessionId) sessions.set(sessionId, history);

    res.json({ reply, sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: errorReply, sessionId });
  }
});

app.get("/available-slots", (req, res) => {
  const { date, service_id } = req.query;

  if (!date || typeof date !== "string" || !date.trim()) {
    return res.status(400).json({ error: "Missing or invalid query parameter: date (e.g. YYYY-MM-DD)." });
  }
  const dateTrimmed = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTrimmed)) {
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
  }
  if (!service_id || typeof service_id !== "string" || !service_id.trim()) {
    return res.status(400).json({ error: "Missing or invalid query parameter: service_id." });
  }

  // Получаем длительность услуги (сначала из БД, иначе из in-memory services)
  db.get(
    "SELECT duration_minutes FROM services WHERE id = ?",
    [service_id.trim()],
    (err, service) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to load service." });
      }

      let duration;
      if (service) {
        duration = service.duration_minutes;
      } else {
        const fromMemory = servicesEn.find((s) => s.id === service_id.trim()) ||
          servicesPl.find((s) => s.id === service_id.trim());
        if (!fromMemory) {
          return res.status(400).json({ error: "Service not found" });
        }
        duration = fromMemory.duration_min;
      }

      // Генерируем все возможные слоты
      const startTimes = generateSlots(duration);
      const allSlots = startTimes.map((start) => {
        const [h, m] = start.split(":").map(Number);
        const endMinutes = h * 60 + m + duration;
        const eh = Math.floor(endMinutes / 60);
        const em = endMinutes % 60;
        const end = `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
        return { start, end };
      });

      // Получаем уже занятые записи
      db.all(
        "SELECT start_time, end_time FROM appointments WHERE date = ?",
        [dateTrimmed],
        (err, appointments) => {
          if (err) {
            console.error(err);
            return res.status(500).json({ error: "Failed to load appointments." });
          }

          const available = allSlots.filter((slot) => {
            return !(appointments || []).some((app) =>
              app.start_time < slot.end && app.end_time > slot.start
            );
          });

          res.json(available);
        }
      );
    }
  );
});

app.post("/book", (req, res) => {
  const body = req.body || {};
  const name = (body.name != null ? String(body.name).trim() : "") || (body.client_name != null ? String(body.client_name).trim() : "");
  const email = (body.email != null ? String(body.email).trim() : "") || (body.client_email != null ? String(body.client_email).trim() : "");
  const service_id = (body.service_id != null ? String(body.service_id).trim() : "");
  const date = (body.date != null ? String(body.date).trim() : "");
  const start_time = (body.start_time != null ? String(body.start_time).trim() : "");
  const end_timeBody = (body.end_time != null ? String(body.end_time).trim() : "");

  if (!name || !email || !service_id || !date || !start_time) {
    return res.status(400).json({
      error: "Missing required fields: name, email, service_id, date, start_time.",
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
  }

  const timeRegex = /^\d{1,2}:\d{2}$/;
  if (!timeRegex.test(start_time)) {
    return res.status(400).json({ error: "Invalid start_time format. Use HH:mm." });
  }

  createBooking({ name, email, service_id, date, start_time })
    .then((result) => {
      const end_time = result.end_time || end_timeBody;
      if (email && process.env.EMAIL_USER) {
        transporter.sendMail({
          from: `"Nail Salon" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "Booking Confirmation 💅",
          html: `
            <h2>Your appointment is confirmed!</h2>
            <p>Service: ${service_id}</p>
            <p>Date: ${date}</p>
            <p>Time: ${start_time} - ${end_time}</p>
          `,
        }).catch((mailErr) => console.error("Send mail error:", mailErr));
      }
      res.json({ success: true });
    })
    .catch((err) => {
      const msg = typeof err === "string" ? err : (err && err.message) || "Failed to create booking.";
      if (msg === "Service not found") return res.status(400).json({ error: msg });
      if (msg === "Slot already booked") return res.status(400).json({ error: msg });
      console.error("Booking error:", err);
      res.status(500).json({ error: msg });
    });
});

// Serve frontend (HTML, JS, CSS) — after API routes so /admin/appointments returns JSON
app.use(express.static(path.join(__dirname, "public")));

app.listen(3001, "0.0.0.0", () => {
  console.log("Server started on http://localhost:3001");
  console.log("Open the site: http://localhost:3001/");
});
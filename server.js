// server.js : API + cron pour vérifier réservations expirées
require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all rooms (info)
app.get('/api/rooms', (req, res) => {
  const rows = db.prepare('SELECT * FROM rooms ORDER BY id').all();
  res.json(rows);
});

// New endpoint: get available rooms between two dates
// Query: /api/available-rooms?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
app.get('/api/available-rooms', (req, res) => {
  const { checkIn, checkOut } = req.query;
  if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut required' });
  // Return rooms that do NOT have an active reservation overlapping the interval
  const rows = db.prepare(`
    SELECT r.*
    FROM rooms r
    WHERE NOT EXISTS (
      SELECT 1 FROM reservations res
      WHERE res.room_id = r.id
        AND res.status = 'active'
        AND NOT (date(res.check_out) <= date(?) OR date(res.check_in) >= date(?))
    )
    ORDER BY r.id
  `).all(checkIn, checkOut);
  res.json(rows);
});

// Create reservation
// Body: { client: { name, email, phone }, roomId, checkIn, checkOut }
// This operation is wrapped in a transaction to avoid race conditions (double-booking)
const createReservationTx = db.transaction((client, roomId, checkIn, checkOut) => {
  // 0) verify room exists
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) {
    const e = new Error('Room not found');
    e.code = 'ROOM_NOT_FOUND';
    throw e;
  }

  // 1) Vérifier disponibilité (dans la même transaction)
  const overlapping = db.prepare(`
    SELECT 1 FROM reservations
    WHERE room_id = ?
      AND status = 'active'
      AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))
    LIMIT 1
  `).get(roomId, checkIn, checkOut);

  if (overlapping) {
    const e = new Error('Chambre indisponible pour ces dates');
    e.code = 'OVERLAP';
    throw e;
  }

  // 2) Créer ou récupérer client
  let clientRow = db.prepare('SELECT * FROM clients WHERE email = ?').get(client.email);
  if (!clientRow) {
    const info = db.prepare('INSERT INTO clients (name, email, phone) VALUES (?, ?, ?)').run(client.name, client.email, client.phone || null);
    clientRow = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  }

  // 3) Créer réservation
  const infoRes = db.prepare('INSERT INTO reservations (client_id, room_id, check_in, check_out) VALUES (?, ?, ?, ?)').run(clientRow.id, roomId, checkIn, checkOut);
  const reservation = db.prepare('SELECT r.*, c.name as client_name, c.email as client_email, rm.number as room_number FROM reservations r JOIN clients c ON r.client_id=c.id JOIN rooms rm ON r.room_id=rm.id WHERE r.id = ?').get(infoRes.lastInsertRowid);

  return reservation;
});

app.post('/api/reservations', (req, res) => {
  try {
    const { client, roomId, checkIn, checkOut } = req.body;
    if (!client || !client.name || !client.email || !roomId || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    // Basic date validation
    if (new Date(checkIn) >= new Date(checkOut)) {
      return res.status(400).json({ error: 'checkIn must be before checkOut' });
    }

    // Use transaction to avoid race conditions
    let reservation;
    try {
      reservation = createReservationTx({ name: client.name, email: client.email, phone: client.phone || null }, Number(roomId), checkIn, checkOut);
    } catch (err) {
      if (err && err.code === 'OVERLAP') {
        return res.status(409).json({ error: 'Chambre indisponible pour ces dates' });
      }
      if (err && err.code === 'ROOM_NOT_FOUND') {
        return res.status(400).json({ error: 'Chambre introuvable' });
      }
      throw err;
    }

    res.status(201).json({ reservation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// List reservations
app.get('/api/reservations', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.name AS client_name, c.email AS client_email, rm.number AS room_number
    FROM reservations r
    JOIN clients c ON r.client_id = c.id
    JOIN rooms rm ON r.room_id = rm.id
    ORDER BY r.created_at DESC
  `).all();
  res.json(rows);
});

// Cron: vérifier réservations expirées (check_out < now) et envoyer email si alert_sent = 0
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
});

// Function to check expired
async function checkExpired() {
  const nowDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const toAlert = db.prepare(`
    SELECT r.*, c.name AS client_name, c.email AS client_email, rm.number AS room_number
    FROM reservations r
    JOIN clients c ON r.client_id = c.id
    JOIN rooms rm ON r.room_id = rm.id
    WHERE date(check_out) < date(?) AND status = 'active' AND alert_sent = 0
  `).all(nowDate);

  for (const r of toAlert) {
    try {
      if (process.env.SMTP_HOST) {
        const info = await transporter.sendMail({
          from: process.env.ALERT_FROM || process.env.SMTP_USER,
          to: r.client_email,
          subject: `Votre réservation #${r.id} est arrivée à expiration`,
          text: `Bonjour ${r.client_name},
Votre réservation pour la chambre ${r.room_number} (du ${r.check_in} au ${r.check_out}) est expirée. Merci.`
        });
        console.log('Alerte envoyée:', info.messageId);
      } else {
        console.log(`DEBUG: Envoi d'alerte à ${r.client_email} pour reservation ${r.id}`);
      }

      // Mark as alert_sent and expired
      db.prepare('UPDATE reservations SET alert_sent = 1, status = ? WHERE id = ?').run('expired', r.id);
    } catch (err) {
      console.error('Erreur envoi alerte pour reservation', r.id, err);
    }
  }
}

// Schedule cron every 10 minutes
cron.schedule('*/10 * * * *', () => {
  console.log('Cron: vérification des réservations expirées', new Date().toISOString());
  checkExpired().catch(console.error);
});

// Also run once on startup
checkExpired().catch(console.error);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});

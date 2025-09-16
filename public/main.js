// main.js : logique frontend mise à jour pour rechercher chambres disponibles avant réservation
document.addEventListener('DOMContentLoaded', async () => {
  const roomsDiv = document.getElementById('rooms');
  const roomSelect = document.getElementById('roomSelect');
  const reservationsDiv = document.getElementById('reservations');
  const resForm = document.getElementById('reservationForm');
  const searchForm = document.getElementById('searchForm');
  const searchCheckIn = document.getElementById('searchCheckIn');
  const searchCheckOut = document.getElementById('searchCheckOut');
  const resCheckIn = document.getElementById('resCheckIn');
  const resCheckOut = document.getElementById('resCheckOut');

  async function loadRoomsInfo() {
    const res = await fetch('/api/rooms');
    const rooms = await res.json();
    roomsDiv.innerHTML = '';
    rooms.forEach(r => {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `<strong>Chambre ${r.number}</strong> <span class="small">(${r.type}, capacité ${r.capacity})</span><div class="small">Prix: ${(r.price_cents/100).toFixed(2)} €</div>`;
      roomsDiv.appendChild(el);
    });
  }

  async function loadReservations() {
    const res = await fetch('/api/reservations');
    const list = await res.json();
    reservationsDiv.innerHTML = '';
    list.forEach(r => {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `<strong>#${r.id} — ${r.room_number}</strong> <div class="small">Client: ${r.client_name} (${r.client_email})</div>
        <div class="small">Du ${r.check_in} au ${r.check_out} — statut: ${r.status}</div>`;
      reservationsDiv.appendChild(el);
    });
  }

  // Search available rooms and populate the room select
  async function searchAvailableRooms(checkIn, checkOut) {
    if (!checkIn || !checkOut) {
      alert('Veuillez fournir les deux dates pour la recherche.');
      return;
    }
    if (new Date(checkIn) >= new Date(checkOut)) {
      alert('La date de sortie doit être après la date d\'entrée.');
      return;
    }
    const res = await fetch(`/api/available-rooms?checkIn=${encodeURIComponent(checkIn)}&checkOut=${encodeURIComponent(checkOut)}`);
    if (!res.ok) {
      const err = await res.json().catch(()=>({error:'Erreur recherche'}));
      alert('Erreur: ' + (err.error || 'Impossible de rechercher'));
      return;
    }
    const rooms = await res.json();
    roomSelect.innerHTML = '<option value="">-- sélectionnez --</option>';
    if (rooms.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Aucune chambre disponible';
      roomSelect.appendChild(opt);
      alert('Aucune chambre disponible pour ces dates.');
      return;
    }
    rooms.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.number} — ${r.type} — ${ (r.price_cents/100).toFixed(2) } €`;
      roomSelect.appendChild(opt);
    });
    // Pre-fill reservation date inputs with searched dates
    resCheckIn.value = checkIn;
    resCheckOut.value = checkOut;
  }

  // Event: search form submit
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const checkIn = searchCheckIn.value;
    const checkOut = searchCheckOut.value;
    await searchAvailableRooms(checkIn, checkOut);
  });

  // Event: reservation form submit
  resForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(resForm);
    const body = {
      client: {
        name: data.get('name'),
        email: data.get('email'),
        phone: data.get('phone')
      },
      roomId: Number(data.get('roomId')),
      checkIn: data.get('checkIn'),
      checkOut: data.get('checkOut')
    };

    // Basic date validation
    if (new Date(body.checkIn) >= new Date(body.checkOut)) {
      alert('La date de sortie doit être après la date d\'entrée.');
      return;
    }

    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      alert('Réservation créée !');
      resForm.reset();
      // refresh reservations and room info
      await loadReservations();
      await loadRoomsInfo();
    } else {
      const err = await res.json().catch(() => ({ error: 'Erreur serveur' }));
      alert('Erreur: ' + (err.error || JSON.stringify(err)));
    }
  });

  await loadRoomsInfo();
  await loadReservations();
});

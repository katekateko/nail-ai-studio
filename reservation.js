(function () {
  const API_BASE = window.NAIL_STUDIO_API_BASE || "http://localhost:3001";
  const serviceSelect = document.getElementById("service-select");
  const timeSelect = document.getElementById("time-select");
  const dateInput = document.getElementById("booking-date");
  const form = document.getElementById("booking-form");

  async function loadServices() {
    const lang = document.documentElement.lang || "en";

    const response = await fetch(
      `${API_BASE}/services?lang=${encodeURIComponent(lang)}`
    );

    const services = await response.json();

    const placeholderText = lang === "pl" ? "Wybierz usługę" : "Select service";
    serviceSelect.innerHTML = `<option value="">${placeholderText}</option>`;

    (Array.isArray(services) ? services : []).forEach(function (service) {
      const option = document.createElement("option");
      option.value = service.id;
      option.textContent = `${service.name} (${service.price != null ? service.price : ""})`;
      serviceSelect.appendChild(option);
    });
  }

  loadServices().catch(function () {
    serviceSelect.innerHTML = '<option value="">Select service</option>';
  });

  // Загружаем слоты
  function loadSlots() {
    const date = dateInput.value ? dateInput.value.trim() : "";
    const service_id = serviceSelect.value ? serviceSelect.value.trim() : "";

    const lang = document.documentElement.lang || "en";
    const selectTimeText = lang === "pl" ? "Wybierz godzinę" : "Select time";
    timeSelect.innerHTML = '<option value="">' + selectTimeText + "</option>";

    if (!date || !service_id) return;

    fetch(API_BASE + "/available-slots?date=" + encodeURIComponent(date) + "&service_id=" + encodeURIComponent(service_id))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        const slots = result.ok && Array.isArray(result.data)
          ? result.data
          : (result.data && result.data.available != null ? result.data.available : []);
        timeSelect.innerHTML = '<option value="">' + selectTimeText + "</option>";
        slots.forEach(function (slot) {
          const option = document.createElement("option");
          option.value = JSON.stringify(slot);
          option.textContent = (slot.start || slot) + (slot.end != null ? " - " + slot.end : "");
          timeSelect.appendChild(option);
        });
      })
      .catch(function () {
        timeSelect.innerHTML = '<option value="">' + selectTimeText + "</option>";
      });
  }

  dateInput.addEventListener("change", loadSlots);
  serviceSelect.addEventListener("change", loadSlots);

  // Отправка формы
  form.addEventListener("submit", function (e) {
    e.preventDefault();

    const name = (document.getElementById("client-name").value || "").trim();
    const email = (document.getElementById("client-email").value || "").trim();
    const service_id = (serviceSelect.value || "").trim();
    const date = (dateInput.value || "").trim();
    const slotValue = timeSelect.value || "";

    if (!name || !email || !service_id || !date || !slotValue) {
      alert(document.documentElement.lang === "pl" ? "Wypełnij wszystkie pola." : "Please fill all fields.");
      return;
    }

    let slot;
    try {
      slot = JSON.parse(slotValue);
    } catch (err) {
      alert(document.documentElement.lang === "pl" ? "Wybierz godzinę." : "Select time.");
      return;
    }

    if (!slot || slot.start == null || slot.end == null) {
      alert(document.documentElement.lang === "pl" ? "Wybierz godzinę." : "Select time.");
      return;
    }

    fetch(API_BASE + "/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name,
        email: email,
        service_id: service_id,
        date: date,
        start_time: slot.start,
        end_time: slot.end
      })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (result.data && result.data.success) {
          alert(document.documentElement.lang === "pl" ? "Rezerwacja potwierdzona!" : "Booking confirmed!");
          form.reset();
          loadSlots();
        } else {
          alert(result.data && result.data.error ? result.data.error : (document.documentElement.lang === "pl" ? "Nie udało się zarezerwować." : "Booking failed."));
        }
      })
      .catch(function () {
        alert(document.documentElement.lang === "pl" ? "Błąd połączenia." : "Connection error.");
      });
  });

  var minDate = new Date();
  minDate.setDate(minDate.getDate());
  dateInput.min = minDate.toISOString().slice(0, 10);
})();

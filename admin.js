/**
 * Admin reservations table: Backend (DB) → server.js endpoint → admin.js fetch → HTML table
 * No sign-in required; reservations load from GET /admin/appointments.
 */
(function () {
  const API_BASE = (function () {
    if (window.NAIL_STUDIO_API_BASE) return window.NAIL_STUDIO_API_BASE;
    var o = window.location.origin;
    if (o && o !== "null" && o.indexOf("file") !== 0) return o;
    return "http://localhost:3001";
  })();
  const tbody = document.getElementById("reservations-body");

  if (!tbody) return;

  let lastRows = [];
  let dateSort = "desc"; // "asc" | "desc" – toggles on Date header click

  function authHeaders() {
    return { "Content-Type": "application/json" };
  }

  function formatTime(row) {
    if (row.start_time && row.end_time) return row.start_time + " – " + row.end_time;
    return row.start_time || "—";
  }

  /** Format YYYY-MM-DD as "3 March 2026" */
  function formatDate(dateStr) {
    if (!dateStr || typeof dateStr !== "string") return "—";
    const parts = dateStr.trim().split("-");
    if (parts.length !== 3) return dateStr;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) return dateStr;
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (month < 0 || month > 11) return dateStr;
    return day + " " + months[month] + " " + year;
  }

  function statusClass(s) {
    if (!s) return "";
    if (s === "cancelled") return "status-cancelled";
    if (s === "completed") return "status-completed";
    return "status-confirmed";
  }

  /** Sort rows by date (row.date YYYY-MM-DD). Order is "asc" or "desc". */
  function sortRowsByDate(rows, order) {
    const copy = rows.slice();
    copy.sort(function (a, b) {
      const dA = a.date || "";
      const dB = b.date || "";
      if (dA < dB) return order === "asc" ? -1 : 1;
      if (dA > dB) return order === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }

  function applyDateSort(rows) {
    return dateSort ? sortRowsByDate(rows, dateSort) : rows;
  }

  function updateDateSortIcon() {
    const icon = document.getElementById("date-sort-icon");
    if (icon) icon.textContent = dateSort === "asc" ? " ↑" : dateSort === "desc" ? " ↓" : "";
  }

  function renderTableRows(rows) {
    if (!rows || rows.length === 0) {
      tbody.innerHTML = "<tr><td colspan=\"7\" class=\"admin-empty\">No reservations yet.</td></tr>";
      return;
    }
    tbody.innerHTML = rows
      .map(function (row) {
        const status = (row.status || "confirmed").toLowerCase();
        return (
          "<tr data-id=\"" + row.id + "\">" +
          "<td>" + formatDate(row.date) + "</td>" +
          "<td>" + formatTime(row) + "</td>" +
          "<td>" + (row.service_name || row.service_id || "—") + "</td>" +
          "<td>" + (row.client_name || "—") + "</td>" +
          "<td>" + (row.client_email || "—") + "</td>" +
          "<td><span class=\"status-badge " + statusClass(status) + "\">" + status + "</span></td>" +
          "<td class=\"col-actions\">" +
          "<button type=\"button\" class=\"btn-cancel\" data-action=\"cancel\">Cancel</button>" +
          "</td></tr>"
        );
      })
      .join("");
    bindRowActions();
  }

  function bindRowActions() {
    tbody.querySelectorAll("button[data-action=cancel]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const tr = btn.closest("tr");
        const id = tr && tr.getAttribute("data-id");
        if (!id) return;
        if (!confirm("Cancel this reservation?")) return;
        fetch(API_BASE + "/appointments/" + id, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ status: "cancelled" })
        })
          .then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
          })
          .then(function (r) {
            if (r.ok && r.data && r.data.success) loadAppointments();
            else alert(r.data && r.data.error ? r.data.error : "Failed to cancel.");
          })
          .catch(function () { alert("Connection error."); });
      });
    });
  }

  /**
   * Fetch appointments from GET /appointments and fill the table.
   */
  async function loadAppointments() {
    const tbodyEl = document.querySelector("#reservations-table tbody") || tbody;
    tbodyEl.innerHTML = "<tr><td colspan=\"7\" class=\"admin-empty\">Loading…</td></tr>";

    try {
      const response = await fetch(API_BASE + "/appointments");

      const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
      const text = await response.text();
      if (contentType.indexOf("text/html") !== -1 || (text.trim().indexOf("<") === 0)) {
        tbodyEl.innerHTML = "<tr><td colspan=\"7\" class=\"admin-empty\">" +
          "Server returned a web page instead of data. Make sure the backend is running: <code>cd backend && npm start</code>, then click Refresh list." +
          "</td></tr>";
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        tbodyEl.innerHTML = "<tr><td colspan=\"7\" class=\"admin-empty\">Invalid response from server.</td></tr>";
        return;
      }

      let rows = Array.isArray(data) ? data : [];
      if (!Array.isArray(data) && data && Array.isArray(data.appointments)) rows = data.appointments;
      else if (!Array.isArray(data) && data && Array.isArray(data.data)) rows = data.data;

      if (!response.ok) {
        tbodyEl.innerHTML = "<tr><td colspan=\"7\" class=\"admin-empty\">" + (data && data.error || "Failed to load.") + "</td></tr>";
        return;
      }

      lastRows = rows;
      renderTableRows(applyDateSort(rows));
      updateDateSortIcon();
    } catch (err) {
      console.error("Admin fetch error:", err);
      tbodyEl.innerHTML = "<tr><td colspan=\"7\" class=\"admin-empty\">" +
        "Cannot reach server at " + API_BASE + ". Start the backend: <code>cd backend && npm start</code>, then click Refresh list." +
        "</td></tr>";
    }
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // Footer year
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Sign out
  var signoutBtn = document.getElementById("admin-signout");
  if (signoutBtn) {
    signoutBtn.addEventListener("click", function () {
      try { localStorage.removeItem("adminToken"); } catch (e) {}
      window.location.href = "index.html";
    });
  }

  // Load appointments from backend and fill table
  loadAppointments();

  // Date column: click to toggle ASC / DESC
  var colDate = document.getElementById("col-date");
  if (colDate) {
    colDate.addEventListener("click", function () {
      dateSort = dateSort === "asc" ? "desc" : "asc";
      renderTableRows(applyDateSort(lastRows));
      updateDateSortIcon();
    });
  }

  // Expose refresh for the Refresh button
  window.refreshReservations = loadAppointments;
})();

(function () {
  var btn = document.getElementById("admin-refresh");
  if (btn && window.refreshReservations) {
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "Loading…";
      window.refreshReservations();
      setTimeout(function () {
        btn.disabled = false;
        btn.textContent = "Refresh list";
      }, 500);
    });
  }
})();

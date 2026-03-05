const WORK_START = 10;
const WORK_END = 19;

/**
 * Generates available start-time slots (every 30 min) within working hours.
 * Only includes slots where start + durationMinutes does not exceed WORK_END.
 * @param {number} durationMinutes - Length of the appointment (e.g. 40 for classic manicure)
 * @returns {string[]} Array of start times in "HH:mm" format
 */
function generateSlots(durationMinutes) {
  const slots = [];
  const duration = durationMinutes || 30;
  const endMinutes = WORK_END * 60;

  for (let hour = WORK_START; hour < WORK_END; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const startMinutes = hour * 60 + minute;
      if (startMinutes + duration > endMinutes) continue;

      const start = `${hour.toString().padStart(2, "0")}:${minute
        .toString()
        .padStart(2, "0")}`;
      slots.push(start);
    }
  }

  return slots;
}

module.exports = generateSlots;
module.exports.WORK_START = WORK_START;
module.exports.WORK_END = WORK_END;

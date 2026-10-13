// HELPMAN Phase 2 — ZIP/service-area feedback on public intake.
(function(){
  'use strict';
  document.addEventListener('focusout', async (e) => {
    if (!e.target || e.target.id !== 'wz-zip') return;
    const input = e.target;
    const zip = input.value.trim();
    let slot = document.getElementById('hm-service-area-status');
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'hm-service-area-status';
      slot.className = 'hint';
      input.parentElement.appendChild(slot);
    }
    if (!/^\d{5}$/.test(zip)) { slot.textContent = 'Enter a 5-digit ZIP code to check service availability.'; return; }
    slot.textContent = 'Checking service availability…';
    try {
      const r = await HP.api('GET','/customer-experience/service-area?zip='+encodeURIComponent(zip));
      slot.className = r.available === true ? 'hint hm-area-ok' : r.available === false ? 'hint hm-area-no' : 'hint';
      slot.textContent = r.message;
    } catch(e) {
      slot.className = 'hint';
      slot.textContent = 'We will confirm service availability before booking.';
    }
  }, true);
})();

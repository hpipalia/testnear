/**
 * TestNear v3.0 — app.js
 * Features: Map, Spanish i18n, PWA install, Booking links, SMS Reminders, Share
 */

/* ═══ STATE ═══ */
let LANG = 'en';
let T    = {};
let allSites    = [];
let currentView = 'list';
let mapInstance = null;
let mapMarkers  = [];
let deferredPWA = null;
let currentClinic = null;
const filters = new Set(['hiv','sti']);
const qa = {};

/* ═══════════════════════════════════════════
   FEATURE 2: SPANISH / i18n
═══════════════════════════════════════════ */
async function loadLang(lang) {
  try {
    const r = await fetch(`/locales/${lang}.json`);
    if (!r.ok) throw new Error('lang file missing');
    T    = await r.json();
    LANG = lang;
    document.getElementById('htmlRoot').lang = lang;
    document.querySelectorAll('.lang-btn').forEach(b =>
      b.classList.toggle('active', b.textContent.toLowerCase() === lang)
    );
    applyTranslations();
    if (allSites.length) rerender();
    renderQuiz();
  } catch (e) {
    console.warn('[i18n] Failed to load', lang, e);
  }
}

function t(key, fallback) {
  const parts = key.split('.');
  let obj = T;
  for (const p of parts) {
    if (!obj || typeof obj !== 'object') return fallback || key;
    obj = obj[p];
  }
  return (obj !== undefined && obj !== null) ? obj : (fallback || key);
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(el.getAttribute('data-i18n'));
    if (typeof v === 'string') el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });

  // Swap hotline numbers based on language
  // EN: 1-800-232-4636 (CDC National HIV/AIDS Hotline)
  // ES: 1-800-344-7432 (Spanish HIV hotline)
  const isES = LANG === 'es';
  const hotlineNum    = isES ? '18003447432' : '18002324636';
  const hotlineLabel  = isES ? '1-800-344-7432' : '1-800-232-4636';

  // Topbar link
  const topbarLink = document.getElementById('topbar-hotline');
  if (topbarLink) { topbarLink.href = `tel:${hotlineNum}`; topbarLink.textContent = hotlineLabel; }

  // Crisis float button
  const crisis = document.querySelector('.crisis');
  if (crisis) {
    crisis.setAttribute('onclick', `window.location='tel:${hotlineNum}'`);
    const numDiv = crisis.querySelector('div > div:last-child');
    if (numDiv) numDiv.textContent = hotlineLabel;
  }

  // Footer HIV hotline list item
  const ftHiv = document.getElementById('ft-hiv-line');
  if (ftHiv) {
    ftHiv.innerHTML = `<a href="tel:${hotlineNum}">HIV: ${hotlineLabel}</a>`;
  }
}

function setLang(lang) { loadLang(lang); }

/* ═══════════════════════════════════════════
   TAB NAV
═══════════════════════════════════════════ */
function showTab(name) {
  ['locator','resources','quiz'].forEach(n => {
    document.getElementById(`section-${n}`).classList.toggle('active', n === name);
    document.getElementById(`tab-${n}`).classList.toggle('active', n === name);
  });
  if (name === 'quiz') renderQuiz();
}

/* ═══════════════════════════════════════════
   FILTER CHIPS
═══════════════════════════════════════════ */
function toggleChip(k) {
  const el = document.getElementById('chip-'+k);
  if (filters.has(k)) { filters.delete(k); el.classList.remove('on'); }
  else                { filters.add(k);    el.classList.add('on'); }
  if (allSites.length) rerender();
}

/* ═══════════════════════════════════════════
   GPS
═══════════════════════════════════════════ */
function useGPS() {
  if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
  const btn = document.getElementById('gpsBtn');
  const span = btn.querySelector('span');
  span.textContent = t('search.gpsGetting', 'Getting location…');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    pos => { span.textContent = t('search.gps', 'Use my current location'); btn.disabled = false; reverseGeo(pos.coords.latitude, pos.coords.longitude); },
    ()  => { span.textContent = t('search.gps', 'Use my current location'); btn.disabled = false; alert('Could not access location. Please enter ZIP code manually.'); },
    { timeout: 8000 }
  );
}

async function reverseGeo(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`);
    const d = await r.json();
    const zip = d.address?.postcode?.split('-')[0];
    if (zip) { document.getElementById('zipInput').value = zip; doSearch(); }
    else     { callAPI({ lat, lng, radius: 10 }); }
  } catch { callAPI({ lat, lng, radius: 10 }); }
}

/* ═══════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════ */
function doSearch() {
  const zip = document.getElementById('zipInput').value.trim();
  if (!zip) { document.getElementById('zipInput').focus(); return; }
  callAPI({ zip, radius: document.getElementById('radSel').value });
}

async function callAPI(params) {
  const qs = new URLSearchParams();
  if (params.zip)    qs.set('zip',    params.zip);
  if (params.lat)    qs.set('lat',    params.lat);
  if (params.lng)    qs.set('lng',    params.lng);
  if (params.radius) qs.set('radius', params.radius);
  if (filters.has('free'))   qs.set('free',   'true');
  if (filters.has('walkin')) qs.set('walkin', 'true');
  if (filters.has('prep'))   qs.set('prep',   'true');

  setLoading(true, params.zip || 'your location');

  try {
    const res  = await fetch(`/api/search?${qs}`);
    const json = await res.json();
    setLoading(false);
    if (!json.success) { showErr(json.errors?.join(', ') || 'Search failed.'); return; }
    allSites = json.results || [];
    renderAll(json, params.zip || 'your location', params.radius || 10);
  } catch {
    setLoading(false);
    showErr(t('status.error', 'Could not reach server. Check your connection.'));
  }
}

/* ═══════════════════════════════════════════
   RENDER ALL
═══════════════════════════════════════════ */
function renderAll(json, label) {
  document.getElementById('statsRow').classList.remove('hidden');
  document.getElementById('appLayout').classList.remove('hidden');
  document.getElementById('viewToggleWrap').classList.remove('hidden');

  document.getElementById('s-total').textContent  = json.total  || allSites.length;
  document.getElementById('s-free').textContent   = allSites.filter(s => hasTag(s,'Free') || hasTag(s,'Sliding Scale')).length;
  document.getElementById('s-walkin').textContent = allSites.filter(s => hasTag(s,'Walk-in')).length;
  document.getElementById('s-prep').textContent   = allSites.filter(s => hasTag(s,'PrEP')).length;
  document.getElementById('badge-count').textContent = allSites.length;

  if (json.meta?.source) {
    const lbl = document.getElementById('srcLbl');
    lbl.textContent = `${json.meta.source.toUpperCase()}${json.cached ? ' (cached)' : ''}`;
    lbl.className   = `src-lbl sc-${json.meta.source}`;
    lbl.classList.remove('hidden');
  }

  rerender();
  if (currentView === 'map') refreshMap();
}

/* ═══════════════════════════════════════════
   FILTER + SORT + LIST RENDER
═══════════════════════════════════════════ */
function rerender() {
  let sites = clientFilter([...allSites]);
  const sort = document.getElementById('sortSel').value;
  if      (sort === 'dist') sites.sort((a,b) => (parseFloat(a.distance)||99) - (parseFloat(b.distance)||99));
  else if (sort === 'name') sites.sort((a,b) => (a.name||'').localeCompare(b.name||''));
  else if (sort === 'free') sites.sort((a,b) => (hasTag(b,'Free')?1:0) - (hasTag(a,'Free')?1:0));

  const list = document.getElementById('cardList');
  list.innerHTML = '';
  if (!sites.length) {
    list.innerHTML = `<div class="no-res"><div style="font-size:38px;margin-bottom:12px;opacity:.35">🔍</div><h3>${t('status.noResults','No results match your filters')}</h3><p>${t('status.noResultsSub','Try removing filters or expanding radius.')}</p></div>`;
    return;
  }
  sites.slice(0,30).forEach((s,i) => list.appendChild(buildCard(s,i)));
}

function clientFilter(sites) {
  return sites.filter(s => {
    const tags = (s.services||[]).map(v => v.toLowerCase()).join(' ');
    if (filters.has('hiv')  && !tags.includes('hiv'))                                          return false;
    if (filters.has('conf') && !tags.includes('confidential') && !tags.includes('anonymous')) return false;
    if (filters.has('hep')  && !tags.includes('hepatitis'))                                   return false;
    return true;
  });
}

/* ═══════════════════════════════════════════
   FEATURE 1: INTERACTIVE MAP (Leaflet.js)
═══════════════════════════════════════════ */
function setView(view) {
  currentView = view;
  document.getElementById('btnListView').classList.toggle('active', view==='list');
  document.getElementById('btnMapView').classList.toggle('active', view==='map');
  document.getElementById('listViewCol').classList.toggle('hidden', view==='map');
  document.getElementById('detailCol').classList.toggle('hidden', view==='map');
  document.getElementById('mapViewCol').classList.toggle('hidden', view==='list');
  if (view === 'map') setTimeout(refreshMap, 80);
}

function refreshMap() {
  if (typeof L === 'undefined') { console.warn('Leaflet not loaded'); return; }

  if (!mapInstance) {
    mapInstance = L.map('map', { zoomControl: true }).setView([39.5,-98.35], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(mapInstance);
  }

  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];

  const sites = clientFilter([...allSites]).filter(s => s.lat && s.lng);
  if (!sites.length) { return; }

  const bounds = [];
  sites.forEach(s => {
    const pinColor = hasTag(s,'Free') ? '#1A7A54' : '#C8392B';
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:26px;height:26px;background:${pinColor};border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);"></div>`,
      iconSize: [26,26], iconAnchor: [13,26], popupAnchor: [0,-28],
    });

    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((s.name||'')+' '+(s.address||''))}`;
    const popup = `
      <div style="font-family:'Outfit',sans-serif;min-width:210px;font-size:13px;">
        <strong style="display:block;margin-bottom:4px;font-size:14px;">${esc(s.name)}</strong>
        <span style="color:#666;font-size:11px;">${esc(s.address||'')}</span>
        ${s.distance?`<div style="margin-top:4px;font-size:11px;color:#C8392B;font-weight:700;">📍 ${s.distance} mi away</div>`:''}
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
          ${s.phone?`<a href="tel:${s.phone}" style="font-size:11px;font-weight:700;color:#1A7A54;background:#E8F5EF;padding:4px 9px;border-radius:4px;text-decoration:none;">📞 Call</a>`:''}
          <a href="${mapsUrl}" target="_blank" style="font-size:11px;font-weight:700;color:#1D5FA6;background:#EAF1FB;padding:4px 9px;border-radius:4px;text-decoration:none;">🗺 Directions</a>
        </div>
        <button onclick="window.selectFromMap('${s.id}')" style="margin-top:8px;width:100%;background:#C8392B;color:#fff;border:none;border-radius:5px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;">View Full Details →</button>
      </div>`;

    const marker = L.marker([s.lat, s.lng], { icon })
      .addTo(mapInstance)
      .bindPopup(popup, { maxWidth: 270, closeButton: true });
    mapMarkers.push(marker);
    bounds.push([s.lat, s.lng]);
  });

  if (bounds.length) mapInstance.fitBounds(bounds, { padding: [50,50], maxZoom: 13 });
  setTimeout(() => mapInstance.invalidateSize(), 150);
}

// Global hook for popup button (needs global scope)
window.selectFromMap = function(id) {
  setView('list');
  setTimeout(() => {
    const site = allSites.find(s => s.id === id);
    if (!site) return;
    document.querySelectorAll('.card').forEach(c => {
      if (c.getAttribute('data-id') === id) { openDetail(site, c); c.scrollIntoView({ behavior:'smooth', block:'center' }); }
    });
  }, 200);
};

/* ═══════════════════════════════════════════
   CARD BUILDER
═══════════════════════════════════════════ */
function buildCard(s, i) {
  const div = document.createElement('div');
  div.className = 'card';
  div.setAttribute('data-id', s.id);
  div.style.animationDelay = (i*35)+'ms';
  div.setAttribute('role','button');
  div.setAttribute('tabindex','0');
  div.setAttribute('aria-label', s.name);

  // FEATURE 4: Booking link
  const bookUrl = detectBookingUrl(s);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((s.name||'')+' '+(s.address||''))}`;

  div.innerHTML = `
    <div class="card-top">
      <div class="card-name">${esc(s.name)}</div>
      ${s.distance ? `<div class="card-dist">${s.distance} mi</div>` : ''}
    </div>
    <div class="card-addr">📍 ${esc(s.address || 'Address not available')}</div>
    <div class="card-tags">${buildTagHTML(s)}</div>
    ${bookUrl ? '<div><span class="book-badge">📅 Online Booking Available</span></div>' : ''}
    <div class="card-btns" style="margin-top:8px;">
      ${s.phone ? `<a class="cbtn cb-call" href="tel:${s.phone}" onclick="event.stopPropagation()">📞 ${fmtPhone(s.phone)}</a>` : ''}
      <a class="cbtn cb-dir" href="${mapsUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${t('card.directions','Directions')}</a>
      ${s.website ? `<a class="cbtn cb-web" href="${s.website}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${t('card.website','Website')}</a>` : ''}
      <button class="cbtn cb-share" onclick="event.stopPropagation();doShare(${i})">${t('card.share','Share')}</button>
    </div>
    ${s.hours ? `<div class="card-hours">🕐 ${esc(s.hours)}</div>` : ''}
  `;

  div.addEventListener('click',   () => openDetail(s, div));
  div.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') openDetail(s,div); });

  // Store reference for share button
  div._site = s;
  return div;
}

/* ═══════════════════════════════════════════
   DETAIL PANEL
═══════════════════════════════════════════ */
function openDetail(s, cardEl) {
  currentClinic = s;
  document.querySelectorAll('.card.sel').forEach(c => c.classList.remove('sel'));
  if (cardEl) cardEl.classList.add('sel');

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((s.name||'')+' '+(s.address||''))}`;
  const bookUrl = detectBookingUrl(s);
  const tips    = t('detail.tips') || [];

  document.getElementById('detailPanel').innerHTML = `
    <div class="det-hero">
      <div class="det-name">${esc(s.name)}</div>
      <div class="det-addr">📍 ${esc(s.address||'')}</div>
      <div class="det-tags">${buildTagHTML(s)}</div>
    </div>
    <div class="det-body">
      <div style="margin-bottom:18px;">
        <div class="ds-ttl">${t('detail.contact','Contact & Hours')}</div>
        ${s.phone ? `<div class="dr"><div class="dr-icon">📞</div><div class="dr-lbl">${t('detail.phone','Phone')}</div><div><a href="tel:${s.phone}" style="color:var(--blue)">${fmtPhone(s.phone)}</a></div></div>` : ''}
        ${s.website ? `<div class="dr"><div class="dr-icon">🌐</div><div class="dr-lbl">${t('detail.web','Website')}</div><div><a href="${s.website}" target="_blank" rel="noopener" style="color:var(--blue)">Visit →</a></div></div>` : ''}
        <div class="dr"><div class="dr-icon">🕐</div><div class="dr-lbl">${t('detail.hours','Hours')}</div><div style="${!s.hours?'color:var(--text3)':''}">${s.hours ? esc(s.hours) : t('detail.hoursNA','Call to confirm hours')}</div></div>
        ${s.distance ? `<div class="dr"><div class="dr-icon">📏</div><div class="dr-lbl">${t('detail.distance','Distance')}</div><div>${s.distance} ${t('detail.miles','miles')}</div></div>` : ''}
        <div class="dr"><div class="dr-icon">🗄</div><div class="dr-lbl">${t('detail.source','Source')}</div><div style="color:var(--text3)">${s.source||'CDC/HRSA'}</div></div>
      </div>
      <div style="margin-bottom:18px;">
        <div class="ds-ttl">${t('detail.services','Services Offered')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;">${buildTagHTML(s)}</div>
      </div>
      <div>
        <div class="ds-ttl">${t('detail.beforeYouGo','Before You Go')}</div>
        <ul style="padding-left:16px;font-size:13px;color:var(--text2);line-height:2.1;">
          ${tips.length ? tips.map(tip=>`<li>${tip}</li>`).join('') : `
            <li>Call ahead to confirm hours & walk-in availability</li>
            <li>Many sites test without ID or insurance</li>
            <li>Bring ID if making an appointment</li>
            <li>Rapid HIV results often available same day</li>
            <li>Ask about PrEP if you want HIV prevention medication</li>
          `}
        </ul>
      </div>
    </div>
    <div class="det-actions">
      ${s.phone ? `<a class="da da-red" href="tel:${s.phone}">📞 ${t('detail.callBtn','Call')}: ${fmtPhone(s.phone)}</a>` : ''}
      ${bookUrl  ? `<a class="da da-green" href="${bookUrl}" target="_blank" rel="noopener">📅 Book Appointment Online</a>` : ''}
      <a class="da da-gray" href="${mapsUrl}" target="_blank" rel="noopener">🗺 ${t('detail.dirBtn','Get Directions')}</a>
      ${s.website ? `<a class="da da-gray" href="${s.website}" target="_blank" rel="noopener">🌐 ${t('detail.siteBtn','Official Website')}</a>` : ''}
      <button class="da da-teal" onclick="doShare(null)">🔗 ${t('detail.shareBtn','Share This Clinic')}</button>
      <button class="da da-gray" onclick="openReminderModal()">⏰ ${t('detail.reminderBtn','Set Testing Reminder')}</button>
    </div>
  `;
  document.getElementById('detailPanel').scrollTo({ top:0, behavior:'smooth' });
  if (window.innerWidth < 820) document.getElementById('detailPanel').scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ═══════════════════════════════════════════
   FEATURE 4: BOOKING URL DETECTION
═══════════════════════════════════════════ */
const BOOKING_ORGS = [
  { match: 'plannedparenthood.org', url: null },
  { match: 'positiveimpacthealthcenters.org', url: null },
  { match: 'zocdoc.com', url: null },
  { match: 'mychart', url: null },
  { match: 'questdiagnostics.com', url: 'https://appointment.questdiagnostics.com/as/patient' },
  { match: 'labcorp.com', url: 'https://www.labcorp.com/labs-and-appointments' },
];
const BOOKING_NAMES = [
  { name: 'planned parenthood', url: 'https://www.plannedparenthood.org/get-care' },
  { name: 'positive impact', url: 'https://www.positiveimpacthealthcenters.org' },
  { name: 'aid atlanta', url: 'https://www.aidatlanta.org/services/testing/' },
];

function detectBookingUrl(s) {
  const w = (s.website||'').toLowerCase();
  const n = (s.name||'').toLowerCase();
  for (const o of BOOKING_ORGS) {
    if (w.includes(o.match)) return o.url || s.website;
  }
  for (const o of BOOKING_NAMES) {
    if (n.includes(o.name)) return o.url;
  }
  return null;
}

/* ═══════════════════════════════════════════
   FEATURE 6: SHARE CLINIC
═══════════════════════════════════════════ */
async function doShare(cardIdx) {
  const s = (cardIdx !== null && cardIdx !== undefined)
    ? [...document.querySelectorAll('.card')][cardIdx]?._site
    : currentClinic;
  if (!s) return;

  const shareUrl  = `${location.origin}/?site=${encodeURIComponent(s.id||'')}`;
  const shareText = `${s.name}\n${s.address||''}\n${s.phone ? fmtPhone(s.phone) : ''}\n\nFind HIV/STI testing near you — TestNear`;

  if (navigator.share) {
    try {
      await navigator.share({ title: `${s.name} — HIV/STI Testing`, text: shareText, url: shareUrl });
      return;
    } catch { /* user cancelled */ return; }
  }
  // Fallback: clipboard
  try {
    await navigator.clipboard.writeText(shareUrl);
    showToast(t('card.copied','Link copied!') + ' ✓');
  } catch {
    prompt('Copy this link:', shareUrl);
  }
}

function showToast(msg, durationMs = 2800) {
  const el = document.getElementById('shareToast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), durationMs);
}

/* ═══════════════════════════════════════════
   FEATURE 5: SMS REMINDER MODAL
═══════════════════════════════════════════ */
function openReminderModal() {
  const s = currentClinic;
  if (!s) return;

  const months3  = LANG==='es' ? '3 meses' : '3 months';
  const months6  = LANG==='es' ? '6 meses' : '6 months';
  const months12 = LANG==='es' ? '12 meses (1 año)' : '12 months (1 year)';

  document.getElementById('modalContent').innerHTML = `
    <h3>${t('reminder.title','Set a Testing Reminder')}</h3>
    <p>${t('reminder.sub',"Enter your number and we'll send one SMS reminder — never stored.")}</p>
    <div class="modal-clinic">
      <strong>${esc(s.name)}</strong>
      ${s.phone ? fmtPhone(s.phone) : ''}
    </div>
    <label>${t('reminder.phoneLabel','Your Phone Number')}</label>
    <input type="tel" id="reminderPhone" placeholder="${t('reminder.phonePlaceholder','+1 (404) 555-0123')}" autocomplete="tel"/>
    <label>${t('reminder.when','Remind me in')}</label>
    <select id="reminderMonths">
      <option value="3">${months3}</option>
      <option value="6">${months6}</option>
      <option value="12">${months12}</option>
    </select>
    <div class="modal-actions">
      <button class="btn-modal-send" id="btnSendReminder" onclick="sendReminder()">${t('reminder.send','Send Reminder')}</button>
      <button class="btn-modal-skip" onclick="closeModal()">${t('reminder.skip','No thanks')}</button>
    </div>
    <p class="modal-privacy">${t('reminder.privacy','Your number is used only for this reminder and never stored.')}</p>
  `;
  document.getElementById('reminderModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('reminderPhone')?.focus(), 100);
}

async function sendReminder() {
  const phone  = document.getElementById('reminderPhone')?.value?.trim();
  const months = document.getElementById('reminderMonths')?.value;
  const btn    = document.getElementById('btnSendReminder');
  if (!phone) { document.getElementById('reminderPhone')?.focus(); return; }

  btn.textContent = t('reminder.sending','Sending…');
  btn.disabled    = true;

  try {
    const res  = await fetch('/api/reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, months: parseInt(months), clinicName: currentClinic?.name, lang: LANG }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed');

    const label = LANG==='es' ? `${months} meses` : `${months} months`;
    document.getElementById('modalContent').innerHTML = `
      <div class="modal-success">
        <div class="modal-success-icon">✅</div>
        <h4>${t('reminder.success','Reminder set!')} ${label}</h4>
        <p style="font-size:13px;color:var(--text2);line-height:1.6;margin-bottom:20px;">
          ${json.mode === 'dev_log'
            ? '(Dev mode: real SMS requires Twilio keys in .env)'
            : (LANG==='es' ? `Recibirá un SMS en ${label}.` : `You'll receive an SMS in ${label}.`)}
        </p>
        <button class="btn-modal-send" onclick="closeModal()">Done ✓</button>
      </div>`;
  } catch (e) {
    btn.textContent = t('reminder.send','Send Reminder');
    btn.disabled    = false;
    alert(t('reminder.error','Could not set reminder. Please try again.'));
  }
}

function closeModal() {
  document.getElementById('reminderModal').classList.add('hidden');
}

/* ═══════════════════════════════════════════
   FEATURE 3: PWA — Progressive Web App
═══════════════════════════════════════════ */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPWA = e;
  document.getElementById('pwaBanner').classList.remove('hidden');
  document.getElementById('btnInstall').addEventListener('click', async () => {
    document.getElementById('pwaBanner').classList.add('hidden');
    deferredPWA.prompt();
    const { outcome } = await deferredPWA.userChoice;
    console.log('[PWA] Install outcome:', outcome);
    deferredPWA = null;
  });
});

window.addEventListener('appinstalled', () => {
  showToast('TestNear installed! ✓');
  document.getElementById('pwaBanner').classList.add('hidden');
});

/* ═══════════════════════════════════════════
   QUIZ RENDERER (i18n-aware)
═══════════════════════════════════════════ */
const SCORE_WEIGHTS = [
  [3,2,1,0],   // q1: never, >2y, 1-2y, recent
  [3,2,1,0,0], // q2: often, sometimes, rarely, no, none
  [0,1,2,3],   // q3: none, one, 2-3, many
  [3,0],       // q4: yes, no
  [2,0,2],     // q5: yes, no, unsure
];

function renderQuiz() {
  const card = document.getElementById('quizCard');
  if (!card) return;
  const questions = t('quiz.questions') || [];
  if (!questions.length) { card.innerHTML = '<p style="padding:20px;color:var(--text3)">Loading quiz…</p>'; return; }

  const steps = questions.map((q, i) => `
    <div class="qstep${i===0?' active':''}" id="qs${i+1}">
      <div class="qprog">
        <div class="qprog-bar"><div class="qprog-fill" style="width:${((i+1)/questions.length)*100}%"></div></div>
        <div class="qprog-lbl">${i+1} ${t('quiz.step','of')} ${questions.length}</div>
      </div>
      <div class="qq">${q.q}</div>
      <div class="qopts">
        ${q.opts.map((o,oi) => `<button class="qopt" onclick="pick(this,${i+1},${oi})" role="radio" aria-pressed="false"><div class="qcircle"></div>${o}</button>`).join('')}
      </div>
      <div class="qnav">
        ${i > 0 ? `<button class="qback" onclick="goQ(${i})">${t('quiz.back','← Back')}</button>` : ''}
        ${i < questions.length-1
          ? `<button class="qnext" onclick="goQ(${i+2})">${t('quiz.next','Next →')}</button>`
          : `<button class="qnext" onclick="showQuizResult()">${t('quiz.seeResults','See Results →')}</button>`}
      </div>
    </div>`).join('');

  card.innerHTML = steps + `
    <div class="qstep" id="qs-res">
      <div id="quizResultContent"></div>
      <div style="text-align:center;margin-top:18px;">
        <button class="qback" onclick="resetQuiz()">${t('quiz.startOver','← Start Over')}</button>
      </div>
    </div>`;
}

function goQ(n) {
  document.querySelectorAll('.qstep').forEach(s => s.classList.remove('active'));
  const id = n === 'res' ? 'qs-res' : `qs${n}`;
  document.getElementById(id)?.classList.add('active');
}

function pick(el, step, valIdx) {
  el.closest('.qopts').querySelectorAll('.qopt').forEach(o => {
    o.classList.remove('sel'); o.querySelector('.qcircle').textContent=''; o.setAttribute('aria-pressed','false');
  });
  el.classList.add('sel'); el.querySelector('.qcircle').textContent='✓'; el.setAttribute('aria-pressed','true');
  qa['q'+step] = valIdx;
}

function showQuizResult() {
  let score = 0;
  for (let i=1; i<=5; i++) {
    const idx = qa['q'+i];
    if (idx !== undefined && SCORE_WEIGHTS[i-1]) score += SCORE_WEIGHTS[i-1][idx] || 0;
  }
  const key = score<=2 ? 'low' : score<=5 ? 'mod' : 'high';
  const res = t(`quiz.results.${key}`) || { icon:'✅', level:'RESULT', title:'Result', msg:'See a healthcare provider.', rec:'Get tested.' };

  document.getElementById('quizResultContent').innerHTML = `
    <div style="text-align:center;padding:8px 0;">
      <div style="font-size:50px;margin-bottom:14px;">${res.icon}</div>
      <div class="lvl-${key}" style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:4px 14px;border-radius:30px;margin-bottom:14px;">${res.level}</div>
      <h2 style="font-size:21px;font-weight:800;margin-bottom:10px;">${res.title}</h2>
      <p style="font-size:13px;color:var(--text2);line-height:1.7;margin-bottom:18px;">${res.msg}</p>
      <div style="background:var(--surface2);border-radius:var(--r-sm);padding:13px 15px;text-align:left;margin-bottom:20px;font-size:13px;">
        <strong style="display:block;margin-bottom:3px;">Recommended action:</strong>
        <span style="color:var(--text2)">${res.rec}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:9px;max-width:300px;margin:0 auto;">
        <button class="qnext" style="width:100%" onclick="showTab('locator')">${t('quiz.findTesting','🗺 Find Testing Near Me')}</button>
        <a class="qback" href="https://www.cdc.gov/hiv/basics/prep.html" target="_blank" rel="noopener"
           style="display:block;text-align:center;padding:9px 18px;border-radius:var(--r-sm);font-size:14px;font-weight:600;background:var(--surface2);color:var(--text2);border:1px solid var(--border)">
          ${t('quiz.learnPrep','Learn About PrEP →')}
        </a>
      </div>
    </div>`;
  goQ('res');
}

function resetQuiz() {
  Object.keys(qa).forEach(k => delete qa[k]);
  renderQuiz();
}

/* ═══════════════════════════════════════════
   UTILITY FUNCTIONS
═══════════════════════════════════════════ */
const TAG_MAP = {
  'HIV Testing':'t-hiv','STI Testing':'t-sti','STI Panel':'t-sti',
  'Free':'t-free','Sliding Scale':'t-free',
  'Confidential':'t-conf','Anonymous':'t-conf',
  'Walk-in':'t-walk','PrEP':'t-prep',
  'Hepatitis':'t-hep','Rapid Testing':'t-rapid',
  'By Appointment':'t-def',
};

function buildTagHTML(s) {
  const svcs = s.services || [];
  if (!svcs.length) return '<span class="tag t-def">Testing Site</span>';
  return svcs.map(sv => `<span class="tag ${TAG_MAP[sv]||'t-def'}">${esc(sv)}</span>`).join('');
}

function hasTag(s, tag) {
  return (s.services||[]).some(sv => sv.toLowerCase().includes(tag.toLowerCase()));
}

function fmtPhone(p) {
  const d = (p||'').replace(/\D/g,'');
  return d.length===10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : p;
}

function esc(s) {
  return String(s||'').replace(/[&<>"']/g,
    m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])
  );
}

function setLoading(on, label='') {
  const wrap = document.getElementById('statusWrap');
  const spin = wrap.querySelector('.spinner');
  if (on) {
    wrap.classList.remove('hidden');
    spin.style.display = '';
    document.getElementById('statusMsg').textContent = `${t('status.searching','Searching near')} ${label}…`;
    document.getElementById('srcLbl').classList.add('hidden');
    document.getElementById('searchBtn').disabled = true;
    document.getElementById('appLayout').classList.add('hidden');
    document.getElementById('statsRow').classList.add('hidden');
    document.getElementById('viewToggleWrap').classList.add('hidden');
  } else {
    wrap.classList.add('hidden');
    spin.style.display = 'none';
    document.getElementById('searchBtn').disabled = false;
  }
}

function showErr(msg) {
  const wrap = document.getElementById('statusWrap');
  wrap.classList.remove('hidden');
  wrap.querySelector('.spinner').style.display = 'none';
  document.getElementById('statusMsg').textContent = '⚠️ ' + msg;
  document.getElementById('appLayout').classList.add('hidden');
}

/* ═══════════════════════════════════════════
   EVENT LISTENERS & INIT
═══════════════════════════════════════════ */
document.getElementById('zipInput').addEventListener('keydown', e => { if(e.key==='Enter') doSearch(); });
document.getElementById('reminderModal').addEventListener('click', e => { if(e.target===document.getElementById('reminderModal')) closeModal(); });
document.addEventListener('keydown', e => { if(e.key==='Escape') closeModal(); });

// Init
loadLang('en');

// Service Worker registration (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(e => console.log('[SW] Registration skipped:', e.message));
  });
}

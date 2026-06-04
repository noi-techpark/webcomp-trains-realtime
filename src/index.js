// SPDX-FileCopyrightText: NOI Techpark <digital@noi.bz.it>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import L from 'leaflet';
import leafletCSS from 'leaflet/dist/leaflet.css';

const DEFAULT_SIRI_BASE = 'https://siri.api.dev.testingmachine.eu/anshar/rest/vm/';

class TrainsRealtimeSta extends HTMLElement {
  constructor() {
    super();
    this.shadow    = this.attachShadow({ mode: 'open' });
    this._map      = null;
    this._markers  = new Map(); // id → L.Marker
    this._timer    = null;
    this._vehicles = [];
  }

  static get observedAttributes() {
    return ['siri-url', 'dataset-id', 'refresh-interval', 'height'];
  }

  get _siriUrl() {
    const custom = this.getAttribute('siri-url');
    if (custom) return custom;
    const datasetId = this.getAttribute('dataset-id') || 'SADtrains';
    return `${DEFAULT_SIRI_BASE}?datasetId=${encodeURIComponent(datasetId)}`;
  }

  get _refreshMs() {
    return Math.max(10, parseInt(this.getAttribute('refresh-interval') || '30')) * 1000;
  }

  get _height() {
    return this.getAttribute('height') || '500px';
  }

  attributeChangedCallback(name, _old, _new) {
    if (!this._map) return;
    if (name === 'height') {
      this.shadow.querySelector('#container').style.height = this._height;
      this._map.invalidateSize();
    } else {
      this._restartTimer();
      this._fetchAndUpdate();
    }
  }

  connectedCallback() { this._mount(); }

  disconnectedCallback() {
    this._stopTimer();
    if (this._map) { this._map.remove(); this._map = null; }
  }

  _mount() {
    this.shadow.innerHTML = `
      <style>
        ${leafletCSS}
        :host { display: block; font-family: sans-serif; }
        #container {
          display: flex;
          height: ${this._height};
          overflow: hidden;
          position: relative;
        }

        /* ── sidebar ── */
        #sidebar {
          width: 260px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          border-right: 1px solid #ddd;
          background: #fff;
          overflow: hidden;
        }
        #search-wrap { padding: 8px; border-bottom: 1px solid #eee; }
        #search {
          width: 100%;
          box-sizing: border-box;
          padding: 6px 10px;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 13px;
          outline: none;
        }
        #search:focus { border-color: #3498db; }
        #count { padding: 4px 10px; font-size: 11px; color: #888; border-bottom: 1px solid #eee; }
        #train-list { flex: 1; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
        .ti {
          padding: 7px 10px;
          border-bottom: 1px solid #f0f0f0;
          cursor: pointer;
          font-size: 12px;
          line-height: 1.5;
        }
        .ti:hover  { background: #f7f7f7; }
        .ti.active { background: #eaf4ff; }
        .ti-head {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 4px;
        }
        .ti-id   { font-weight: 600; white-space: nowrap; }
        .ti-dest { color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ti-meta { color: #888; font-size: 11px; margin-top: 1px; }

        /* ── map area ── */
        #map-wrap { flex: 1; position: relative; overflow: hidden; }
        #map { width: 100%; height: 100%; }
        #status {
          position: absolute;
          top: 10px; right: 10px;
          z-index: 1000;
          background: rgba(255,255,255,0.92);
          border: 1px solid #ccc;
          border-radius: 4px;
          padding: 4px 10px;
          font-size: 12px;
          pointer-events: none;
          box-shadow: 0 1px 4px rgba(0,0,0,0.15);
        }
        #status.err { background: rgba(255,235,235,0.95); border-color: #c33; color: #a00; }

        .train-marker { line-height: 0; }
      </style>
      <div id="container">
        <div id="sidebar">
          <div id="search-wrap">
            <input id="search" type="search" placeholder="Search trains&hellip;">
          </div>
          <div id="count"></div>
          <ul id="train-list"></ul>
        </div>
        <div id="map-wrap">
          <div id="map"></div>
          <div id="status">Loading&hellip;</div>
        </div>
      </div>
    `;

    this._statusEl = this.shadow.querySelector('#status');
    this._listEl   = this.shadow.querySelector('#train-list');
    this._countEl  = this.shadow.querySelector('#count');
    this._searchEl = this.shadow.querySelector('#search');

    this._searchEl.addEventListener('input', () =>
      this._renderList(this._searchEl.value.trim().toLowerCase())
    );

    this._map = L.map(this.shadow.querySelector('#map'), { preferCanvas: true })
      .setView([46.55, 11.35], 9);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(this._map);

    this._fetchAndUpdate();
    this._restartTimer();
  }

  _stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _restartTimer() {
    this._stopTimer();
    this._timer = setInterval(() => this._fetchAndUpdate(), this._refreshMs);
  }

  async _fetchAndUpdate() {
    try {
      const res = await fetch(this._siriUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const cutoff = Date.now() - 10 * 60 * 1000;
      this._vehicles = (
        data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity ?? []
      ).filter(v => new Date(v.RecordedAtTime).getTime() >= cutoff);
      this._updateMarkers(this._vehicles);
      this._renderList(this._searchEl.value.trim().toLowerCase());
      this._setStatus(`${this._vehicles.length} trains · ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      this._setStatus(`Error: ${e.message}`, true);
    }
  }

  _setStatus(msg, isErr = false) {
    this._statusEl.textContent = msg;
    this._statusEl.className = isErr ? 'err' : '';
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _delaySeconds(iso) {
    if (!iso || iso === 'PT0S') return 0;
    const neg = iso.startsWith('-');
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    const secs = parseInt(m[1] || 0) * 3600 + parseInt(m[2] || 0) * 60 + parseInt(m[3] || 0);
    return neg ? -secs : secs;
  }

  _delayColor(d) {
    if (d < 0)    return '#5dade2'; // early     → light blue
    if (d === 0)  return '#27ae60'; // on time   → green
    if (d < 300)  return '#f1c40f'; // < 5 min  → yellow
    if (d < 1800) return '#e67e22'; // 5–30 min → orange
    return '#c0392b';               // > 30 min → red
  }

  _delayLabel(d) {
    const min = Math.round(Math.abs(d) / 60);
    if (d < 0)   return `−${min} min`;
    if (d === 0) return 'On time';
    return `+${min} min`;
  }

  // ── icon (SVG: dot at GPS anchor + stem + label pill to the right) ────────

  _makeIcon(vehicleId, dest, delaySec) {
    const color  = this._delayColor(delaySec);
    const raw    = `${vehicleId} - ${dest}`;
    const label  = this._esc(raw.length > 18 ? raw.substring(0, 17) + '…' : raw);

    const DOT_R  = 5;
    const STEM   = 5;
    const PILL_H = 16;
    const pillW  = Math.max(48, label.length * 6 + 14);
    const totalW = DOT_R * 2 + STEM + pillW;
    const H      = 20;
    const cy     = H / 2;
    const pillX  = DOT_R * 2 + STEM;
    const pillY  = (H - PILL_H) / 2;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${H}" viewBox="0 0 ${totalW} ${H}">
      <circle cx="${DOT_R}" cy="${cy}" r="${DOT_R - 1}"
              fill="${color}" stroke="white" stroke-width="1.5"/>
      <line x1="${DOT_R * 2}" y1="${cy}" x2="${pillX}" y2="${cy}"
            stroke="${color}" stroke-width="1.5"/>
      <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${PILL_H}" rx="4"
            fill="${color}" stroke="white" stroke-width="1"/>
      <text x="${pillX + pillW / 2}" y="${cy + 4}" text-anchor="middle"
            font-size="9" font-weight="bold" fill="white"
            font-family="Arial,sans-serif">${label}</text>
    </svg>`;

    return L.divIcon({
      html: svg,
      className: 'train-marker',
      iconSize:    [totalW, H],
      iconAnchor:  [DOT_R, cy],
      popupAnchor: [pillW / 2, -cy],
    });
  }

  // ── markers ───────────────────────────────────────────────────────────────

  _popupHtml(journey, vehicleId, delaySec, recordedAt) {
    const line     = this._esc(journey.PublishedLineName?.[0]?.value ?? '?');
    const dest     = this._esc(journey.DirectionName?.[0]?.value ?? '?');
    const dir      = this._esc(journey.DirectionRef?.value ?? '?');
    const operator = this._esc(journey.OperatorRef?.value ?? '?');
    const color    = this._delayColor(delaySec);
    const delayTxt = this._esc(this._delayLabel(delaySec));
    const updated  = new Date(recordedAt).toLocaleTimeString();
    return `
      <div style="min-width:160px;font-family:sans-serif;font-size:13px;line-height:1.6">
        <b style="font-size:14px">Train ${this._esc(vehicleId)}</b><br>
        <b>Line:</b> ${line}<br>
        <b>To:</b> ${dest}<br>
        <b>Direction:</b> ${dir}<br>
        <b>Delay:</b> <span style="color:${color}">${delayTxt}</span><br>
        <b>Operator:</b> ${operator}<br>
        <small style="color:#666">Updated: ${updated}</small>
      </div>`;
  }

  _updateMarkers(vehicles) {
    const seen = new Set();

    for (const v of vehicles) {
      const j = v.MonitoredVehicleJourney;
      if (!j?.VehicleLocation) continue;

      const id    = j.VehicleRef?.value ?? String(Math.random());
      const lat   = j.VehicleLocation.Latitude;
      const lon   = j.VehicleLocation.Longitude;
      const dest  = j.DirectionName?.[0]?.value ?? '?';
      const delay = this._delaySeconds(j.Delay);
      const icon  = this._makeIcon(id, dest, delay);
      const popup = this._popupHtml(j, id, delay, v.RecordedAtTime);

      seen.add(id);

      if (this._markers.has(id)) {
        const m = this._markers.get(id);
        m.setLatLng([lat, lon]);
        m.setIcon(icon);
        m.getPopup().setContent(popup);
        m.getTooltip().setContent(this._esc(dest));
      } else {
        const m = L.marker([lat, lon], { icon })
          .bindPopup(popup)
          .bindTooltip(this._esc(dest))
          .addTo(this._map);
        this._markers.set(id, m);
      }
    }

    for (const [id, m] of this._markers) {
      if (!seen.has(id)) { m.remove(); this._markers.delete(id); }
    }
  }

  // ── sidebar list ──────────────────────────────────────────────────────────

  _renderList(query = '') {
    const filtered = query
      ? this._vehicles.filter(v => {
          const j = v.MonitoredVehicleJourney;
          return (
            (j.VehicleRef?.value ?? '') +
            (j.DirectionName?.[0]?.value ?? '') +
            (j.PublishedLineName?.[0]?.value ?? '')
          ).toLowerCase().includes(query);
        })
      : this._vehicles;

    this._countEl.textContent = query
      ? `${filtered.length} of ${this._vehicles.length} trains`
      : `${this._vehicles.length} trains`;

    const activeId = this._listEl.querySelector('.ti.active')?.dataset.id;

    this._listEl.innerHTML = filtered.map(v => {
      const j      = v.MonitoredVehicleJourney;
      const id     = j.VehicleRef?.value ?? '?';
      const dest   = j.DirectionName?.[0]?.value ?? '?';
      const line   = j.PublishedLineName?.[0]?.value ?? '?';
      const delay  = this._delaySeconds(j.Delay);
      const color  = this._delayColor(delay);
      const active = id === activeId ? ' active' : '';
      return `<li class="ti${active}" data-id="${this._esc(id)}">
        <div class="ti-head">
          <span class="ti-id">${this._esc(id)}</span>
          <span class="ti-dest">${this._esc(dest)}</span>
        </div>
        <div class="ti-meta">
          ${this._esc(line)} &middot;
          <span style="color:${color}">${this._esc(this._delayLabel(delay))}</span>
        </div>
      </li>`;
    }).join('');

    this._listEl.querySelectorAll('.ti').forEach(el => {
      el.addEventListener('click', () => {
        const m = this._markers.get(el.dataset.id);
        if (!m) return;
        this._listEl.querySelectorAll('.ti').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        this._map.setView(m.getLatLng(), Math.max(this._map.getZoom(), 12));
        m.openPopup();
      });
    });
  }
}

customElements.define('trains-realtime-sta', TrainsRealtimeSta);

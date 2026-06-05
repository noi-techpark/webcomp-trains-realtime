// SPDX-FileCopyrightText: NOI Techpark <digital@noi.bz.it>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import L from 'leaflet';
import leafletCSS from 'leaflet/dist/leaflet.css';
import { forceSimulation } from 'd3-force';

const DEFAULT_SIRI_BASE = 'https://siri.api.dev.testingmachine.eu/anshar/rest/vm/';

const DOT_R          = 5;
const PILL_H         = 16;
const LABEL_OFFSET_X = DOT_R * 2 + 4;
const STACK_MARGIN   = 3;

// Rectangular bounding-box collision force for d3-force.
// Treats each node as an axis-aligned rectangle (node.hw × node.hh half-extents).
// Fixed nodes (node.fixed = true) act as immovable obstacles.
// Deliberately does NOT scale by alpha so overlaps are fully resolved every tick.
function rectCollide(padding = 0) {
  let nodes;
  function force() {
    for (let i = 0; i < nodes.length; ++i) {
      const a = nodes[i];
      if (a.fixed) continue;
      const aw = a.hw + padding, ah = a.hh + padding;
      for (let j = 0; j < nodes.length; ++j) {
        if (i === j) continue;
        const b = nodes[j];
        const ox = aw + b.hw + padding - Math.abs(a.x - b.x);
        const oy = ah + b.hh + padding - Math.abs(a.y - b.y);
        if (ox > 0 && oy > 0) {
          const share = b.fixed ? 1 : 0.5;
          if (ox < oy) a.x += (a.x >= b.x ? ox : -ox) * share;
          else         a.y += (a.y >= b.y ? oy : -oy) * share;
        }
      }
    }
  }
  force.initialize = n => { nodes = n; };
  return force;
}

// Radial spring: pulls each badge to exactly baseR pixels from its dot centre.
// Constrains distance only — no angular preference, so badges orbit freely.
function ringForce(strength = 0.2) {
  let nodes;
  const f = alpha => {
    for (const n of nodes) {
      if (n.fixed || !n.item) continue;
      const dx = n.x - n.item.dotPx.x;
      const dy = n.y - n.item.dotPx.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const err  = dist - n.baseR; // positive = too far, negative = too close
      n.x -= (dx / dist) * err * strength * alpha;
      n.y -= (dy / dist) * err * strength * alpha;
    }
  };
  f.initialize = ns => { nodes = ns; };
  return f;
}

class TrainsRealtime extends HTMLElement {
  constructor() {
    super();
    this.shadow      = this.attachShadow({ mode: 'open' });
    this._map        = null;
    this._dots       = new Map(); // id → L.Marker  (exact GPS position, never moved)
    this._labels     = new Map(); // id → L.Marker  (pill, repositioned by _declutter)
    this._linesBg    = new Map(); // id → L.Polyline (white border underneath connector)
    this._lines      = new Map(); // id → L.Polyline (colored connector on top)
    this._markerData = new Map(); // id → { pillW, color }
    this._timer        = null;
    this._vehicles     = [];
    this._filterQuery  = '';
  }

  static get observedAttributes() {
    return ['siri-url', 'dataset-id', 'refresh-interval'];
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

  attributeChangedCallback(_name, _old, _new) {
    if (!this._map) return;
    this._restartTimer();
    this._fetchAndUpdate();
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
        :host { display: block; height: 100%; font-family: sans-serif; }
        #container {
          display: flex;
          height: 100%;
          overflow: hidden;
          position: relative;
        }

        /* ── sidebar toggle ── */
        #sidebar-toggle {
          position: absolute;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          z-index: 1001;
          width: 22px; height: 22px;
          border-radius: 3px;
          background: #fff;
          border: 1px solid #ccc;
          box-shadow: 0 1px 4px rgba(0,0,0,0.18);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          color: #555;
          padding: 0;
          line-height: 1;
          user-select: none;
        }
        #sidebar-toggle:hover { background: #f5f5f5; }

        /* ── sidebar ── */
        #sidebar {
          width: 260px;
          max-width: 40%;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          border-left: 1px solid #ddd;
          background: #fff;
          overflow: hidden;
          transition: width 0.25s ease;
        }
        #sidebar.collapsed { width: 0; border-left: none; }
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
          padding: 4px 8px;
          font-size: 12px;
          pointer-events: none;
          box-shadow: 0 1px 4px rgba(0,0,0,0.15);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        #status.err { background: rgba(255,235,235,0.95); border-color: #c33; color: #a00; }
        #refresh-ring { display: block; flex-shrink: 0; }

        .train-dot   { line-height: 0; }
        .train-label { line-height: 0; cursor: pointer; }

      </style>
      <div id="container">
        <div id="map-wrap">
          <div id="map"></div>
          <div id="status">
            <span id="status-text">Loading&hellip;</span>
            <svg id="refresh-ring" width="14" height="14" viewBox="0 0 14 14">
              <circle cx="7" cy="7" r="5" fill="none"
                      stroke="rgba(0,0,0,0.12)" stroke-width="1.5"/>
              <circle id="progress-arc" cx="7" cy="7" r="5" fill="none"
                      stroke="rgba(0,0,0,0.7)" stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-dasharray="31.416" stroke-dashoffset="31.416"
                      transform="rotate(-90 7 7)"/>
            </svg>
          </div>
          <button id="sidebar-toggle">&#x276F;</button>
        </div>
        <div id="sidebar">
          <div id="search-wrap">
            <input id="search" type="search" placeholder="Search trains&hellip;">
          </div>
          <div id="count"></div>
          <ul id="train-list"></ul>
        </div>
      </div>
    `;

    this._statusEl   = this.shadow.querySelector('#status');
    this._statusTextEl = this.shadow.querySelector('#status-text');
    this._progressEl = this.shadow.querySelector('#progress-arc');
    this._listEl   = this.shadow.querySelector('#train-list');
    this._countEl  = this.shadow.querySelector('#count');
    this._searchEl = this.shadow.querySelector('#search');
    this._sidebarEl = this.shadow.querySelector('#sidebar');
    this._toggleEl  = this.shadow.querySelector('#sidebar-toggle');

    this._toggleEl.addEventListener('click', () => {
      const collapsed = this._sidebarEl.classList.toggle('collapsed');
      this._toggleEl.innerHTML = collapsed ? '&#x276E;' : '&#x276F;';
      setTimeout(() => this._map?.invalidateSize(), 260);
    });

    this._searchEl.addEventListener('input', () =>
      this._renderList(this._searchEl.value.trim().toLowerCase())
    );

    this._map = L.map(this.shadow.querySelector('#map'), { preferCanvas: true })
      .setView([46.55, 11.35], 9);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(this._map);

    // Re-run declutter whenever the viewport changes so labels track correctly
    this._map.on('zoomend moveend', () => this._declutter());

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
    this._resetProgress();
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
    } finally {
      this._startProgress();
    }
  }

  _resetProgress() {
    const el = this._progressEl;
    if (!el) return;
    el.style.transition = 'none';
    el.style.strokeDashoffset = '31.416'; // full offset = empty ring
  }

  _startProgress() {
    const el = this._progressEl;
    if (!el) return;
    el.getBoundingClientRect(); // force reflow so the reset takes effect first
    el.style.transition = `stroke-dashoffset ${this._refreshMs}ms linear`;
    el.style.strokeDashoffset = '0'; // animate to full ring
  }

  _setStatus(msg, isErr = false) {
    this._statusTextEl.textContent = msg;
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

  _pillWidth(lineName, dest) {
    const raw = `${lineName} - ${dest}`;
    const text = raw.length > 18 ? raw.substring(0, 17) + '…' : raw;
    return Math.max(48, text.length * 6 + 14);
  }

  // ── icons ─────────────────────────────────────────────────────────────────

  _makeDotIcon(color) {
    const S = DOT_R * 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
      <circle cx="${DOT_R}" cy="${DOT_R}" r="${DOT_R - 1}"
              fill="${color}" stroke="white" stroke-width="1.5"/>
    </svg>`;
    return L.divIcon({
      html: svg,
      className: 'train-dot',
      iconSize:   [S, S],
      iconAnchor: [DOT_R, DOT_R], // centre of circle = GPS point
    });
  }

  _makeLabelIcon(lineName, dest, delaySec) {
    const color = this._delayColor(delaySec);
    const raw   = `${lineName} - ${dest}`;
    const label = this._esc(raw.length > 18 ? raw.substring(0, 17) + '…' : raw);
    const pillW = Math.max(48, label.length * 6 + 14);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${PILL_H}">
      <rect x="0" y="0" width="${pillW}" height="${PILL_H}" rx="4"
            fill="${color}" stroke="white" stroke-width="1"/>
      <text x="${pillW / 2}" y="${PILL_H / 2 + 4}" text-anchor="middle"
            font-size="9" font-weight="bold" fill="white"
            font-family="Arial,sans-serif">${label}</text>
    </svg>`;

    return L.divIcon({
      html: svg,
      className: 'train-label',
      iconSize:   [pillW, PILL_H],
      iconAnchor: [pillW / 2, PILL_H / 2], // centre of pill = latlng point
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

      const id       = j.VehicleRef?.value ?? String(Math.random());
      const lat      = j.VehicleLocation.Latitude;
      const lon      = j.VehicleLocation.Longitude;
      const dest     = j.DirectionName?.[0]?.value ?? '?';
      const lineName = j.PublishedLineName?.[0]?.value ?? '?';
      const delay    = this._delaySeconds(j.Delay);
      const color    = this._delayColor(delay);
      const pillW    = this._pillWidth(lineName, dest);
      const popup    = this._popupHtml(j, id, delay, v.RecordedAtTime);

      seen.add(id);
      this._markerData.set(id, { pillW, color });

      if (this._dots.has(id)) {
        const dot   = this._dots.get(id);
        const label = this._labels.get(id);
        const line  = this._lines.get(id);
        dot.setLatLng([lat, lon]);
        dot.setIcon(this._makeDotIcon(color));
        dot.getPopup().setContent(popup);
        dot.getTooltip().setContent(this._esc(dest));
        label.setIcon(this._makeLabelIcon(lineName, dest, delay));
        label.getPopup().setContent(popup);
        line.setStyle({ color });
      } else {
        const dot = L.marker([lat, lon], { icon: this._makeDotIcon(color), zIndexOffset: 100 })
          .bindPopup(popup)
          .bindTooltip(this._esc(dest))
          .addTo(this._map);
        this._dots.set(id, dot);

        const label = L.marker([lat, lon], { icon: this._makeLabelIcon(lineName, dest, delay) })
          .bindPopup(popup)
          .addTo(this._map);
        this._labels.set(id, label);

        const lineBg = L.polyline([[lat, lon], [lat, lon]], {
          color: 'white',
          weight: 4,
          opacity: 1,
        }).addTo(this._map);
        this._linesBg.set(id, lineBg);

        const line = L.polyline([[lat, lon], [lat, lon]], {
          color,
          weight: 1.5,
          opacity: 0.9,
        }).addTo(this._map);
        this._lines.set(id, line);
      }
    }

    for (const [id, dot] of this._dots) {
      if (!seen.has(id)) {
        dot.remove();
        this._labels.get(id)?.remove();
        this._linesBg.get(id)?.remove();
        this._lines.get(id)?.remove();
        this._dots.delete(id);
        this._labels.delete(id);
        this._linesBg.delete(id);
        this._lines.delete(id);
        this._markerData.delete(id);
      }
    }

    this._applyVisibility(this._filterQuery);
  }

  // Physics-based label placement using d3-force with rectangular collision.
  // Each badge is attracted toward the right of its dot; rectCollide pushes
  // overlapping badges (and badges overlapping dots) apart naturally.
  _declutter() {
    if (!this._map || this._dots.size === 0) return;

    const q = this._filterQuery;
    const items = [];
    for (const [id, dot] of this._dots) {
      if (q && !this._matchesQuery(id)) continue;
      const label  = this._labels.get(id);
      const line   = this._lines.get(id);
      const lineBg = this._linesBg.get(id);
      const data   = this._markerData.get(id);
      if (!label || !line || !lineBg || !data) continue;
      const dotPx = this._map.latLngToContainerPoint(dot.getLatLng());
      items.push({ id, dotPx, pillW: data.pillW, label, line, lineBg, dot });
    }
    if (items.length === 0) return;

    // Badge nodes — start to the right, ring force keeps them at baseR from their dot
    const badgeNodes = items.map(item => {
      const baseR = LABEL_OFFSET_X + item.pillW / 2;
      return {
        x: item.dotPx.x + baseR,
        y: item.dotPx.y,
        hw: item.pillW / 2, hh: PILL_H / 2,
        baseR, item,
      };
    });

    // Dot nodes — fixed obstacles
    const dotNodes = items.map(item => ({
      x: item.dotPx.x, y: item.dotPx.y,
      hw: DOT_R, hh: DOT_R,
      fixed: true,
    }));

    forceSimulation([...dotNodes, ...badgeNodes])
      .force('collide', rectCollide(2))
      .force('ring',    ringForce(0.2))
      .stop()
      .tick(300);

    for (const node of badgeNodes) {
      const { x: cx, y: cy, hw, hh, item } = node;

      const centerLatLng = this._map.containerPointToLatLng(L.point(cx, cy));
      item.label.setLatLng(centerLatLng);

      // Connector from dot to nearest point on badge edge
      const dx = item.dotPx.x - cx, dy = item.dotPx.y - cy;
      const t = Math.min(
        dx !== 0 ? hw / Math.abs(dx) : Infinity,
        dy !== 0 ? hh / Math.abs(dy) : Infinity,
      );
      const edgeLatLng = this._map.containerPointToLatLng(L.point(cx + t * dx, cy + t * dy));
      item.lineBg.setLatLngs([item.dot.getLatLng(), edgeLatLng]);
      item.line.setLatLngs([item.dot.getLatLng(), edgeLatLng]);
    }
  }

  // ── map filter ───────────────────────────────────────────────────────────

  _matchesQuery(id) {
    const q = this._filterQuery;
    if (!q) return true;
    const v = this._vehicles.find(v => (v.MonitoredVehicleJourney.VehicleRef?.value ?? '') === id);
    if (!v) return false;
    const j = v.MonitoredVehicleJourney;
    return (
      (j.VehicleRef?.value ?? '') +
      (j.DirectionName?.[0]?.value ?? '') +
      (j.PublishedLineName?.[0]?.value ?? '')
    ).toLowerCase().includes(q);
  }

  _applyVisibility(query) {
    this._filterQuery = query;
    for (const [id, dot] of this._dots) {
      const matched = this._matchesQuery(id);
      const display = matched ? '' : 'none';
      dot.getElement()?.style.setProperty('display', display);
      this._labels.get(id)?.getElement()?.style.setProperty('display', display);
      this._linesBg.get(id)?.setStyle({ opacity: matched ? 1 : 0 });
      this._lines.get(id)?.setStyle({ opacity: matched ? 0.9 : 0 });
    }
    this._declutter();
  }

  // ── sidebar list ──────────────────────────────────────────────────────────

  _renderList(query = '') {
    this._applyVisibility(query);
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
        const dot = this._dots.get(el.dataset.id);
        if (!dot) return;
        this._listEl.querySelectorAll('.ti').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        this._map.setView(dot.getLatLng(), Math.max(this._map.getZoom(), 12));
        dot.openPopup();
      });
    });
  }
}

customElements.define('trains-realtime', TrainsRealtime);

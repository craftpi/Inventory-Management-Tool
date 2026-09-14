// =========================================================================
// 1. KONFIGURATION & GLOBALE ZUSTÄNDE
// =========================================================================
const SUPABASE_URL = 'https://trilager-api.pius-s.de';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InRyaWxhZ2VyIiwiaWF0IjoxNzg1ODA3MzI1LCJleHAiOjIxMDExNjczMjV9.COsEZ-KOGycjE2S1eALGohmmjosW8CZs038jezg6lSU';

const STORAGE_KEYS = {
    SESSION: 'trilager_local_session_v2',
    ATTEMPTS: 'trilager_login_attempts_v1',
    LOCK: 'trilager_login_lock_until_v1',
    ONBOARDING: 'lager_onboarding_v1_gesehen'
};

const TABLES = {
    FORMULAR: 'formular_antworten'
};

// Konstanten für das Mengensystem
const BESTAND_STRICH_AUSREICHEND = -2;
const BESTAND_STRICH_NACHKAUF = -3;
const LOCAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

// App-Datenzustände
let aktuelleDaten = [], packlisten = [], packlistenPositionen = [], alleArtikelInfos = [], alleLagerorte = [];
let isEditMode = false, isEventEditMode = false, aktuellerModus = 'lager';
let offeneGruppen = new Set(), isAllOpen = false, sortAscending = true, zeigeAlleArtikel = false;
let aktiverRegalFilter = '';
let finderFilterModus = 'fehlend';
let etikettenAuswahlIds = new Set();
let einkaufslisteArray = [];

// Kisten- & Scan-Zustände
let kistenCheckAktuelleId = '';
let aktiverQrScanner = null;
let aktiverNfcModus = null;
let nfcAbortController = null;
let scanSperre = { kisten: false, rueckgabe: false };

// =========================================================================
// 2. RECHNER-PARSER & MENGEN-HILFSFUNKTIONEN (DAS ORIGINAL-SYSTEM)
// =========================================================================
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}

function showToast(message, type = 'success') {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function closeModal(id) { const el = $(id); if (el) el.style.display = 'none'; }
function openModalById(id) { const el = $(id); if (el) el.style.display = 'block'; }

function populateSelect(selectEl, items, { valueKey = 'id', labelKey = 'name', defaultOption = null, selectedValue = null, formatLabel = null } = {}) {
    if (!selectEl) return;
    const current = selectedValue !== null ? selectedValue : selectEl.value;
    selectEl.innerHTML = defaultOption ? `<option value="">${defaultOption}</option>` : '';
    items.forEach(item => {
        const val = typeof item === 'object' ? item[valueKey] : item;
        const text = formatLabel ? formatLabel(item) : (typeof item === 'object' ? item[labelKey] : item);
        selectEl.add(new Option(text, val));
    });
    if (current && Array.from(selectEl.options).some(o => o.value === String(current))) {
        selectEl.value = current;
    }
}

// Sicherer Mini-Parser für Rechenausdrücke (z.B. "3+2" oder "(4-1)*2")
function berechneMengenAusdruck(ausdruck) {
    let pos = 0;
    const err = () => { throw new Error('Ungültiger Ausdruck'); };
    const parseZahl = () => {
        let start = pos;
        while (pos < ausdruck.length && /[0-9.]/.test(ausdruck[pos])) pos++;
        if (pos === start) err();
        const val = parseFloat(ausdruck.slice(start, pos));
        if (Number.isNaN(val)) err();
        return val;
    };
    const parseFactor = () => {
        if (ausdruck[pos] === '(') {
            pos++; const val = parseExpr();
            if (ausdruck[pos] !== ')') err();
            pos++; return val;
        }
        if (ausdruck[pos] === '-') { pos++; return -parseFactor(); }
        if (ausdruck[pos] === '+') { pos++; return parseFactor(); }
        return parseZahl();
    };
    const parseTerm = () => {
        let val = parseFactor();
        while (ausdruck[pos] === '*' || ausdruck[pos] === '/') {
            const op = ausdruck[pos++];
            const rhs = parseFactor();
            val = op === '*' ? val * rhs : val / rhs;
        }
        return val;
    };
    const parseExpr = () => {
        let val = parseTerm();
        while (ausdruck[pos] === '+' || ausdruck[pos] === '-') {
            const op = ausdruck[pos++];
            const rhs = parseTerm();
            val = op === '+' ? val + rhs : val - rhs;
        }
        return val;
    };
    const res = parseExpr();
    if (pos !== ausdruck.length) err();
    return res;
}

function werteMengeAus(eingabe) {
    if (eingabe === undefined || eingabe === null) return 0;
    const clean = String(eingabe).replace(/[^0-9+\-*/().]/g, '');
    if (!clean) return 0;
    try {
        const res = berechneMengenAusdruck(clean);
        return Number.isFinite(res) ? Math.round(res) : 0;
    } catch { return 0; }
}

function extrahiereRegalName(text) {
    const raw = String(text || '').trim();
    const m = raw.match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : raw;
}

function normalisiereRegalText(text) {
    return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function vergleicheRegalNamen(a, b, sortFactor = 1) {
    const aN = extrahiereRegalName(a), bN = extrahiereRegalName(b);
    return aN.localeCompare(bN, 'de', { numeric: true, sensitivity: 'base' }) * sortFactor;
}

function textEnthaeltRegal(text, regalName) {
    const nReg = normalisiereRegalText(regalName), nTxt = normalisiereRegalText(text);
    if (!nReg || !nTxt) return false;
    if (nTxt.includes(`(${nReg})`)) return true;
    const match = [...String(text).matchAll(/\(([^)]+)\)/g)].some(m => normalisiereRegalText(m[1]) === nReg);
    if (match) return true;
    return new RegExp(`(^|[^a-z0-9])${nReg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(nTxt) || (nReg.length > 3 && nTxt.includes(nReg));
}

function ermittleRegalSchluessel(bestaende) {
    const r = (bestaende || []).map(b => extrahiereRegalName(b.lagerorte?.name || '')).filter(Boolean).sort((a, b) => vergleicheRegalNamen(a, b));
    return r[0] || '';
}

function formatArtikelId(id) {
    if (!id) return '–';
    const n = Number(id);
    return Number.isFinite(n) ? '#' + String(n).padStart(5, '0') : String(id);
}

// Steuerung von Mengen-Feldern und Buttons (∞ und -)
function aktualisiereMengeEingabeFarbe(feld) {
    if (!feld) return;
    const w = String(feld.value ?? '').trim();
    feld.classList.remove('bestand-menge-ok', 'bestand-menge-low');
    if (!w || w === '-' || w === '∞') return;
    const m = werteMengeAus(w);
    if (Number.isFinite(m)) feld.classList.add(m > 0 ? 'bestand-menge-ok' : 'bestand-menge-low');
}

function setzeBestandStatus(row, status = 'zahl', nachkauf = false) {
    if (!row) return;
    const input = row.querySelector('.new-menge, .edit-menge-input');
    const infBtn = row.querySelector('.bestand-btn-inf');
    const minusBtn = row.querySelector('.bestand-btn-minus');
    const nachkaufWrap = row.querySelector('.bestand-nachkauf-wrap');
    const nachkaufCheckbox = row.querySelector('.bestand-nachkauf-checkbox');
    const isStrich = status === 'strich-ok' || status === 'strich-warn';

    row.dataset.stockMode = isStrich ? (status === 'strich-warn' ? 'strich-warn' : 'strich-ok') : status;
    row.dataset.nachkauf = isStrich && nachkauf ? 'true' : 'false';

    if (nachkaufCheckbox) nachkaufCheckbox.checked = Boolean(isStrich && nachkauf);
    if (nachkaufWrap) nachkaufWrap.style.display = isStrich ? 'flex' : 'none';

    if (input) {
        if (status === 'zahl') input.value = input.getAttribute('data-old-value') || (['∞', '-'].includes(input.value) ? '0' : input.value || '0');
        else if (status === 'inf') { if (input.value !== '∞') input.setAttribute('data-old-value', input.value || '0'); input.value = '∞'; }
        else { if (input.value !== '-') input.setAttribute('data-old-value', input.value || '0'); input.value = '-'; }
        aktualisiereMengeEingabeFarbe(input);
    }

    if (infBtn) {
        infBtn.classList.toggle('active-inf', status === 'inf');
        infBtn.style.background = status === 'inf' ? '#27ae60' : '#95a5a6';
    }
    if (minusBtn) {
        minusBtn.classList.toggle('active-minus-ok', status === 'strich-ok' && !nachkauf);
        minusBtn.classList.toggle('active-minus-warn', status === 'strich-warn' || nachkauf);
        minusBtn.style.background = (status === 'strich-warn' || nachkauf) ? '#c0392b' : (status === 'strich-ok' ? '#27ae60' : '#95a5a6');
    }
}

function bestandEingabeGeaendert(feld) {
    const row = feld?.closest('.lagerort-row, .edit-ort-row');
    if (!row || !feld) return;
    const w = String(feld.value ?? '').trim();
    if (w === '∞') setzeBestandStatus(row, 'inf', false);
    else if (w === '-') setzeBestandStatus(row, row.querySelector('.bestand-nachkauf-checkbox')?.checked ? 'strich-warn' : 'strich-ok');
    else setzeBestandStatus(row, 'zahl', false);
}

function leseBestandswertAusZeile(row) {
    const status = row?.dataset?.stockMode || 'zahl';
    const val = String(row?.querySelector('input')?.value ?? '').trim();
    if (status === 'inf' || val === '∞') return -1;
    if (status === 'strich-warn') return BESTAND_STRICH_NACHKAUF;
    if (status === 'strich-ok' || val === '-') return BESTAND_STRICH_AUSREICHEND;
    return werteMengeAus(val);
}

function toggleBestandInf(btn) {
    const row = btn?.closest('.lagerort-row, .edit-ort-row');
    if (row) setzeBestandStatus(row, row.dataset.stockMode === 'inf' ? 'zahl' : 'inf', false);
}
function toggleBestandMinus(btn) {
    const row = btn?.closest('.lagerort-row, .edit-ort-row');
    if (row) setzeBestandStatus(row, row.dataset.stockMode?.startsWith('strich') ? 'zahl' : 'strich-ok', row.dataset.nachkauf === 'true');
}
function toggleNachkaufCheckbox(chk) {
    const row = chk?.closest('.lagerort-row, .edit-ort-row');
    if (row && row.dataset.stockMode?.startsWith('strich')) setzeBestandStatus(row, chk.checked ? 'strich-warn' : 'strich-ok', chk.checked);
}

// =========================================================================
// 3. AUTH & ONBOARDING / HILFE
// =========================================================================
function setzeAuthToken(token) {
    if (token) dbClient.rest.headers.set('Authorization', `Bearer ${token}`);
    else dbClient.rest.headers.delete('Authorization');
}

function holeLokaleSession() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEYS.SESSION);
        if (!raw) return null;
        const session = JSON.parse(raw);
        if (!session || (Number(session.expiresAt) || 0) <= Date.now()) {
            window.localStorage.removeItem(STORAGE_KEYS.SESSION);
            return null;
        }
        return session;
    } catch { return null; }
}

function speichereLokaleSession(user) {
    const session = {
        userName: String(user?.username || 'User'),
        token: String(user?.token || ''),
        expiresAt: Date.now() + LOCAL_SESSION_TTL_MS
    };
    window.localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session));
    setzeAuthToken(session.token);
}

async function handleLogin() {
    const p = $('login-password').value;
    const errEl = $('login-error');

    const { data, error } = await dbClient.rpc('login_user', { p_password: p });
    if (error || !data || data.length === 0) {
        if (errEl) { errEl.style.display = 'block'; errEl.innerText = 'Falsches Passwort!'; }
    } else {
        if (errEl) errEl.style.display = 'none';
        $('login-password').value = '';
        $('login-overlay').style.display = 'none';
        speichereLokaleSession({ username: data.username, token: data.token });
        showToast('Erfolgreich angemeldet!');
        await ladeAlles();
        pruefeUndZeigeOnboarding();
    }
}

function handleLogout() {
    window.localStorage.removeItem(STORAGE_KEYS.SESSION);
    setzeAuthToken(null);
    $('login-overlay').style.display = 'flex';
}

function pruefeUndZeigeOnboarding() {
    if (!window.localStorage.getItem(STORAGE_KEYS.ONBOARDING)) oeffneOnboarding();
}
function oeffneOnboarding() { openModalById('onboardingModal'); }
function schliesseOnboarding() { closeModal('onboardingModal'); window.localStorage.setItem(STORAGE_KEYS.ONBOARDING, '1'); }
function openRechtliches(e, mid) { if (e) e.preventDefault(); openModalById(mid); }

// =========================================================================
// 4. DATEN LADEN & FILTER
// =========================================================================
async function ladeAlles() {
    await ladeLagerorte();
    await ladePacklistenDaten();
    await ladeBestand();
    wendeFilterAn();
    if (aktuellerModus === 'event') zeigePackliste();
    if (aktuellerModus === 'kisten') renderKistenListe();
}

async function ladeLagerorte() {
    const { data } = await dbClient.from('lagerorte').select('*').order('name');
    alleLagerorte = data || [];

    const selectsNeu = document.querySelectorAll('.new-ort');
    selectsNeu.forEach(sel => populateSelect(sel, alleLagerorte));
}

async function ladePacklistenDaten() {
    const { data: listData } = await dbClient.from('packlisten').select('*').order('name');
    packlisten = listData || [];
    populateSelect($('packlisten-auswahl'), packlisten, { defaultOption: '-- Wähle Resort / Packliste --' });

    const { data: posData } = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie, einheit)');
    packlistenPositionen = posData || [];
}

async function ladeBestand() {
    const { data: alleArt } = await dbClient.from('artikel').select('*').order('name');
    alleArtikelInfos = alleArt || [];

    let { data } = await dbClient.from('bestand').select(`
        id, menge, alte_menge, created_at, artikel_id, lagerort_id, 
        artikel (id, name, kategorie, einheit, kommentar, wichtig, typ), 
        lagerorte (id, name, nfc_code)
    `).order('id');

    aktuelleDaten = (data || []).map(z => ({
        ...z,
        soll_menge: (z.alte_menge !== null && Number(z.alte_menge) >= 0) ? Number(z.alte_menge) : (Number(z.menge) >= 0 ? Number(z.menge) : 0)
    }));

    aktualisiereFilterDropdown(aktuelleDaten);
}

function aktualisiereFilterDropdown(daten) {
    const katDropdown = $('kategorie-filter'), datalist = $('kategorie-liste'), comboDropdown = $('ort-filter-combo');
    const artikelDatalist = $('kategorie-artikel-liste');
    const kategorien = new Set(), regale = new Set();

    daten.forEach(z => {
        if (z.artikel?.kategorie?.trim()) kategorien.add(z.artikel.kategorie.trim());
        const regal = extrahiereRegalName(z.lagerorte?.name || '');
        if (regal) regale.add(regal);
    });

    if (katDropdown) populateSelect(katDropdown, Array.from(kategorien).sort(), { defaultOption: 'Alle Kategorien' });
    if (comboDropdown) {
        comboDropdown.innerHTML = '<option value="">Alle Orte</option>';
        alleLagerorte.forEach(o => comboDropdown.add(new Option('📍 ' + o.name, 'ort:' + o.id)));
        Array.from(regale).sort(vergleicheRegalNamen).forEach(r => comboDropdown.add(new Option('🏷️ Regal: ' + r, 'regal:' + r)));
    }
    if (datalist) datalist.innerHTML = Array.from(kategorien).sort().map(k => `<option value="${escapeHtml(k)}">`).join('');
    if (artikelDatalist) artikelDatalist.innerHTML = alleArtikelInfos.map(a => `<option value="${escapeHtml(a.name)}">`).join('');
}

// =========================================================================
// 5. DAS VEREINHEITLICHTE KISTEN-SYSTEM (INHALT, ENTNAHME & RÜCKGABE)
// =========================================================================

function gibKistenBestand(lid) {
    return aktuelleDaten.filter(z => String(z.lagerort_id) === String(lid))
        .sort((a, b) => (a.artikel?.name || '').localeCompare(b.artikel?.name || '', 'de'));
}

function oeffneKistenCheck(lid) {
    const ort = alleLagerorte.find(o => String(o.id) === String(lid));
    if (!ort) return;
    kistenCheckAktuelleId = lid;

    $('kisten-check-titel').innerText = `📦 ${ort.name}`;
    $('kisten-check-code').innerText = ort.nfc_code ? `NFC/QR-Code: ${ort.nfc_code}` : 'Kein Code hinterlegt';

    renderKistenInhaltListe(lid);
    $('kisten-check-edit-bereich').style.display = 'none';
    $('kiste-edit-toggle-btn').innerText = '⚙️ Inhalt bearbeiten';
    openModalById('kistenCheckModal');
}

function renderKistenInhaltListe(lid) {
    const wrapper = $('kisten-check-liste');
    wrapper.innerHTML = '';
    const bestand = gibKistenBestand(lid);

    if (!bestand.length) {
        wrapper.innerHTML = '<p style="color:#7f8c8d; text-align:center; padding:15px;">Diese Kiste hat noch keine zugeordneten Artikel.</p>';
        return;
    }

    bestand.forEach(z => {
        const ist = Number(z.menge);
        const soll = Number(z.soll_menge);
        const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
        const istSonder = ist < 0;
        const einheit = z.artikel?.einheit || 'Stück';

        const card = document.createElement('div');
        card.className = `kiste-item-card ${fehlt > 0 ? 'fehlend' : ''}`;

        let statusText = '';
        if (ist === -1) statusText = '<span style="font-size:1.1em; font-weight:bold; color:#7f8c8d;">∞</span> (Unbegrenzt)';
        else if (ist === -2) statusText = '<span class="bestand-status-pill ok">-</span> Ausreichend vorhanden';
        else if (ist === -3) statusText = '<span class="bestand-status-pill warn">-</span> 🔴 Nachkaufen nötig';
        else {
            statusText = `Soll: <strong>${soll}</strong> ${einheit}`;
            if (fehlt > 0) statusText += ` &bull; <span style="color:#c0392b; font-weight:bold;">${fehlt} fehlen unterwegs</span>`;
            else statusText += ` &bull; <span style="color:#27ae60;">✅ Vollständig</span>`;
        }

        card.innerHTML = `
            <div style="flex:1;">
                <div style="font-weight:bold; font-size:1.02em; color:#2c3e50;">${escapeHtml(z.artikel?.name || 'Unbekannt')}</div>
                <div style="font-size:0.85em; color:#555; margin-top:3px;">${statusText}</div>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
                ${!istSonder ? `
                    <button class="btn" style="background:#e74c3c; width:36px; min-width:36px; height:36px; padding:0; font-size:1.1em;" onclick="aendereArtikelMengeInKiste(${z.id}, -1)" title="1 Stück entnehmen">−</button>
                    <input type="text" id="menge-${z.id}" class="menge-input bestand-menge-input ${ist > 0 ? 'bestand-menge-ok' : 'bestand-menge-low'}" value="${ist}" onchange="speichereMenge(${z.id})" oninput="aktualisiereMengeEingabeFarbe(this)" style="width:60px; height:36px;">
                    <button class="btn" style="background:#27ae60; width:36px; min-width:36px; height:36px; padding:0; font-size:1.1em;" onclick="aendereArtikelMengeInKiste(${z.id}, 1)" title="1 Stück zurückgeben">+</button>
                ` : `
                    <input type="text" id="menge-${z.id}" class="menge-input" value="${ist === -1 ? '∞' : '-'}" onchange="speichereMenge(${z.id})" style="width:60px; height:36px; text-align:center;">
                `}
                <button class="btn" style="background:#e74c3c; padding:6px 10px; width:auto; min-height:36px; margin-left:6px;" onclick="entferneArtikelAusKiste(${z.id})" title="Aus dieser Kiste entfernen">🗑️</button>
            </div>
        `;
        wrapper.appendChild(card);
    });
}

// Ganze Kiste entnehmen (alle zählbaren Artikel auf 0)
async function ganzeKisteAusbuchen() {
    if (!kistenCheckAktuelleId) return;
    if (!confirm('Soll die gesamte Kiste als entnommen ausgebucht werden (Bestand aller zählbaren Artikel wird 0)?')) return;

    const bestand = gibKistenBestand(kistenCheckAktuelleId);
    const updates = bestand.filter(z => Number(z.menge) >= 0).map(z => {
        return dbClient.from('bestand').update({
            menge: 0,
            alte_menge: z.soll_menge || z.menge,
            created_at: new Date().toISOString()
        }).eq('id', z.id);
    });

    await Promise.all(updates);
    showToast('📤 Ganze Kiste als entnommen ausgebucht!');
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

// Ganze Kiste zurückbuchen (alle Artikel auf Soll-Wert)
async function ganzeKisteZurueckbuchen() {
    if (!kistenCheckAktuelleId) return;
    const bestand = gibKistenBestand(kistenCheckAktuelleId);

    const updates = bestand.filter(z => Number(z.menge) >= 0).map(z => {
        const soll = z.soll_menge > 0 ? z.soll_menge : (z.alte_menge > 0 ? z.alte_menge : z.menge);
        return dbClient.from('bestand').update({
            menge: soll,
            created_at: new Date().toISOString()
        }).eq('id', z.id);
    });

    await Promise.all(updates);
    if (navigator.vibrate) navigator.vibrate(200);
    showToast('✅ Kiste vollständig zurückgebucht!');
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

// Einzelnen Artikel in Kiste anpassen (+1 / -1)
async function aendereArtikelMengeInKiste(bestandId, delta) {
    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;
    const aktuell = Number(eintrag.menge);
    if (aktuell < 0) return;

    const neu = Math.max(0, aktuell + delta);
    const soll = eintrag.soll_menge || eintrag.alte_menge || aktuell;

    await dbClient.from('bestand').update({
        menge: neu,
        alte_menge: soll,
        created_at: new Date().toISOString()
    }).eq('id', bestandId);

    if (navigator.vibrate) navigator.vibrate(60);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

function toggleKistenEditForm() {
    const el = $('kisten-check-edit-bereich');
    const istSichtbar = el.style.display !== 'none';
    el.style.display = istSichtbar ? 'none' : 'block';
    $('kiste-edit-toggle-btn').innerText = istSichtbar ? '⚙️ Inhalt bearbeiten' : 'Schließen';
}

async function kistenCheckArtikelHinzufuegen() {
    const inp = $('kisten-check-artikel-input');
    const val = inp.value.trim();
    if (!val) return;

    const art = alleArtikelInfos.find(a => a.name.toLowerCase() === val.toLowerCase());
    if (!art) return showToast(`Artikel "${val}" nicht gefunden.`, 'error');

    const existiert = aktuelleDaten.some(b => b.artikel_id === art.id && String(b.lagerort_id) === String(kistenCheckAktuelleId));
    if (existiert) return showToast('Dieser Artikel ist bereits dieser Kiste zugeordnet.', 'warning');

    const startMenge = prompt(`Soll-Menge für "${art.name}" in dieser Kiste:`, '1');
    if (startMenge === null) return;
    const mengeNum = werteMengeAus(startMenge);

    await dbClient.from('bestand').insert([{
        artikel_id: art.id,
        lagerort_id: Number(kistenCheckAktuelleId),
        menge: mengeNum,
        alte_menge: mengeNum,
        created_at: new Date().toISOString()
    }]);

    inp.value = '';
    showToast(`✅ "${art.name}" zur Kiste hinzugefügt!`);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

async function entferneArtikelAusKiste(bestandId) {
    if (!confirm('Diesen Artikel wirklich aus dieser Kiste entfernen?')) return;
    await dbClient.from('bestand').delete().eq('id', bestandId);
    showToast('Artikel entfernt.');
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

function schliesseKistenCheckModal() {
    closeModal('kistenCheckModal');
    kistenCheckAktuelleId = '';
}

// =========================================================================
// 6. ARTIKEL-FINDER: „WO GEHÖRT DAS HIN? / RÜCKGABE OHNE CODE“
// =========================================================================

function oeffneWoGehoertDasHinModal(vorbelegterSuchbegriff = '') {
    $('artikel-finder-input').value = vorbelegterSuchbegriff;
    finderFilterModus = vorbelegterSuchbegriff ? 'alle' : 'fehlend';
    aktualisiereFinderFilterButtons();
    aktualisiereArtikelFinderListe(vorbelegterSuchbegriff);
    openModalById('artikelFinderModal');
}

function setzeFinderFilter(modus) {
    finderFilterModus = modus;
    aktualisiereFinderFilterButtons();
    aktualisiereArtikelFinderListe($('artikel-finder-input').value);
}

function aktualisiereFinderFilterButtons() {
    const btnFehlend = $('finder-filter-fehlend');
    const btnAlle = $('finder-filter-alle');
    if (!btnFehlend || !btnAlle) return;

    if (finderFilterModus === 'fehlend') {
        btnFehlend.style.background = '#e74c3c';
        btnAlle.style.background = '#95a5a6';
    } else {
        btnFehlend.style.background = '#95a5a6';
        btnAlle.style.background = '#3498db';
    }
}

function aktualisiereArtikelFinderListe(suchbegriff = '') {
    const container = $('artikel-finder-ergebnisse');
    const term = (suchbegriff || '').toLowerCase().trim();

    let treffer = aktuelleDaten.filter(b => {
        const soll = Number(b.soll_menge);
        const ist = Number(b.menge);
        const fehlt = (soll > 0 && ist >= 0 && ist < soll);

        if (term) {
            const matches = (b.artikel?.name || '').toLowerCase().includes(term) ||
                            (b.lagerorte?.name || '').toLowerCase().includes(term) ||
                            (b.artikel?.kategorie || '').toLowerCase().includes(term);
            if (!matches) return false;
        }

        if (finderFilterModus === 'fehlend') return fehlt;
        return true;
    });

    if (!treffer.length) {
        container.innerHTML = `
            <p style="color:#666; text-align:center; padding:25px;">
                ${term ? 'Kein passender Artikel gefunden.' : '🎉 Alle Kisten sind aktuell vollzählig! Keine Fehlteile.'}
            </p>`;
        return;
    }

    container.innerHTML = treffer.map(z => {
        const soll = Number(z.soll_menge);
        const ist = Number(z.menge);
        const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
        const einheit = z.artikel?.einheit || 'Stück';

        let standText = '';
        if (ist === -1) standText = '∞ Unbegrenzt';
        else if (ist === -2 || ist === -3) standText = ist === -3 ? '🔴 Nachkaufen' : 'Ausreichend';
        else standText = `Vorhanden: ${ist} / ${soll} ${einheit} ${fehlt > 0 ? `<span style="color:#c0392b; font-weight:bold;">(${fehlt} fehlen)</span>` : '✅'}`;

        return `
            <div style="border:1px solid #d9e3ec; background:#fff; border-radius:8px; padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
                <div style="flex:1;">
                    <div style="font-size:1.05em; font-weight:bold; color:#2c3e50;">${escapeHtml(z.artikel?.name)}</div>
                    <div style="color:#16a085; font-weight:bold; margin-top:2px;">
                        📍 Gehört in: <u>${escapeHtml(z.lagerorte?.name || 'Unbekannter Ort')}</u>
                    </div>
                    <small style="color:#666;">${standText}</small>
                </div>
                <div style="display:flex; gap:6px;">
                    <button class="btn" style="background:#27ae60; padding:8px 12px; width:auto; min-height:40px;" onclick="buchtArtikelZurueckInKiste(${z.id})">
                        📥 Hier rein (+1)
                    </button>
                    <button class="btn" style="background:#3498db; padding:8px 10px; width:auto; min-height:40px;" onclick="oeffneKistenCheck(${z.lagerort_id})" title="Kiste öffnen">📦</button>
                </div>
            </div>
        `;
    }).join('');
}

async function buchtArtikelZurueckInKiste(bestandId) {
    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;

    const aktuell = Number(eintrag.menge);
    const neu = aktuell < 0 ? aktuell : aktuell + 1;

    await dbClient.from('bestand').update({
        menge: neu,
        created_at: new Date().toISOString()
    }).eq('id', bestandId);

    if (navigator.vibrate) navigator.vibrate(120);
    showToast(`✅ 1x "${eintrag.artikel?.name}" in "${eintrag.lagerorte?.name}" gebucht!`);
    await ladeAlles();
    aktualisiereArtikelFinderListe($('artikel-finder-input').value);
}

// =========================================================================
// 7. HARDWARE SCANNING (KAMERA & NFC)
// =========================================================================

async function starteKameraScanner({ modalId, readerId, statusId, onDecode }) {
    openModalById(modalId);
    const status = $(statusId);
    if (status) status.innerText = 'Kamera wird gestartet…';

    if (aktiverQrScanner) {
        try { await aktiverQrScanner.stop(); aktiverQrScanner.clear(); } catch {}
    }

    aktiverQrScanner = new Html5Qrcode(readerId);
    try {
        await aktiverQrScanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 240, height: 240 } },
            (decoded) => {
                if (status) status.innerText = 'Erkannt: ' + decoded;
                onDecode(decoded);
            },
            () => {}
        );
        if (status) status.innerText = 'Bereit – Code vor die Kamera halten.';
    } catch (err) {
        showToast('Kamera konnte nicht gestartet werden.', 'error');
        stoppeKameraScanner(modalId);
    }
}

function stoppeKameraScanner(modalId) {
    if (aktiverQrScanner) {
        aktiverQrScanner.stop().then(() => aktiverQrScanner.clear()).catch(() => {}).finally(() => { aktiverQrScanner = null; });
    }
    closeModal(modalId);
}

function oeffneKistenKameraModal() {
    starteKameraScanner({
        modalId: 'kistenKameraModal',
        readerId: 'kisten-qr-reader',
        statusId: 'kisten-scanner-status',
        onDecode: verarbeiteUniversalScan
    });
}
function schliesseKistenKameraModal() { stoppeKameraScanner('kistenKameraModal'); }

async function verarbeiteUniversalScan(rawCode) {
    if (scanSperre.kisten) return;
    scanSperre.kisten = true;
    setTimeout(() => scanSperre.kisten = false, 1500);

    const raw = String(rawCode || '').trim();

    let ortCode = null;
    const mKisteUrl = /kistencheck=([^&\s]+)/i.exec(raw);
    const mKistePref = /^(?:ort|behaelter):(.+)$/i.exec(raw);
    if (mKisteUrl) ortCode = decodeURIComponent(mKisteUrl[1]);
    else if (mKistePref) ortCode = mKistePref[1].trim();
    else ortCode = raw;

    const ort = alleLagerorte.find(o => o.nfc_code && o.nfc_code.toLowerCase() === ortCode.toLowerCase());
    if (ort) {
        if (navigator.vibrate) navigator.vibrate(120);
        schliesseKistenKameraModal();
        oeffneKistenCheck(ort.id);
        return;
    }

    let artikelId = null;
    const mArtUrl = /rueckgabe=([^&\s]+)/i.exec(raw);
    const mArtPref = /^artikel:(.+)$/i.exec(raw);
    if (mArtUrl) artikelId = mArtUrl[1].trim();
    else if (mArtPref) artikelId = mArtPref[1].trim();

    if (artikelId) {
        schliesseKistenKameraModal();
        const bestandsEintraege = aktuelleDaten.filter(b => String(b.artikel_id) === String(artikelId));
        if (bestandsEintraege.length === 1) {
            await buchtArtikelZurueckInKiste(bestandsEintraege[0].id);
        } else if (bestandsEintraege.length > 1) {
            const art = alleArtikelInfos.find(a => String(a.id) === String(artikelId));
            oeffneWoGehoertDasHinModal(art?.name || '');
        } else {
            showToast('Artikel hat keinen festen Lagerort.', 'warning');
        }
        return;
    }

    showToast(`Code "${raw}" wurde nicht erkannt.`, 'error');
}

async function starteKistenNfc() {
    if (aktiverNfcModus === 'kisten') {
        deaktiviereNfc();
        return showToast('NFC beendet.');
    }

    if (!('NDEFReader' in window) && typeof window.nfc === 'undefined') {
        return showToast('Web-NFC wird von diesem Browser/Gerät nicht unterstützt.', 'error');
    }

    aktiverNfcModus = 'kisten';
    aktualisiereNfcUI(true);

    if (typeof window.nfc !== 'undefined') {
        window.nfc.addNdefListener(evt => {
            try {
                const text = window.nfc.bytesToString(evt.tag?.ndefMessage?.[0]?.payload);
                if (text) verarbeiteUniversalScan(text);
            } catch {}
        });
        showToast('📶 NFC aktiv: Kiste ans Handy halten.');
        return;
    }

    try {
        nfcAbortController = new AbortController();
        const reader = new NDEFReader();
        await reader.scan({ signal: nfcAbortController.signal });
        showToast('📶 NFC aktiv: Kiste ans Handy halten.');
        reader.onreading = (event) => {
            for (const rec of event.message.records) {
                const text = new TextDecoder().decode(rec.data);
                if (text) { verarbeiteUniversalScan(text); break; }
            }
        };
    } catch (err) {
        deaktiviereNfc();
        showToast('NFC-Fehler: ' + err.message, 'error');
    }
}

function deaktiviereNfc() {
    if (nfcAbortController) { nfcAbortController.abort(); nfcAbortController = null; }
    aktiverNfcModus = null;
    aktualisiereNfcUI(false);
}

function aktualisiereNfcUI(aktiv) {
    ['kisten-nfc-btn', 'kisten-nfc-btn-lager'].forEach(id => {
        const btn = $(id);
        if (btn) {
            btn.classList.toggle('nfc-aktiv', aktiv);
            btn.innerText = aktiv ? '📶 NFC aktiv – zum Stoppen tippen' : '📶 NFC-Scan (Android)';
        }
    });
}

async function schreibeNfcTagFuerOrt() {
    const oId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(oId));
    if (!ort) return showToast('Bitte zuerst Lagerort auswählen.', 'warning');

    let code = ort.nfc_code;
    if (!code) {
        const slug = String(ort.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
        code = `kiste-${slug}-${ort.id}`;
        await dbClient.from('lagerorte').update({ nfc_code: code }).eq('id', ort.id);
        await ladeLagerorte();
        ortSelectChanged();
    }

    const url = `https://trilager.pius-s.de?kistencheck=${encodeURIComponent(code)}`;

    if (!('NDEFReader' in window)) return showToast('NFC-Schreiben im Browser nicht unterstützt.', 'error');
    try {
        const writer = new NDEFReader();
        showToast('📶 Leeren NFC-Tag an das Handy halten…');
        await writer.write({ records: [{ recordType: 'url', data: url }] });
        if (navigator.vibrate) navigator.vibrate(200);
        showToast(`✅ Tag für "${ort.name}" beschrieben!`);
    } catch (err) {
        showToast('Fehler beim Schreiben: ' + err.message, 'error');
    }
}

// =========================================================================
// 8. LAGER-MODUS (TABELLE, PREFIX-GRUPPIERUNG & SICHTBARKEIT)
// =========================================================================

function wendeFilterAn() {
    const katFilter = $('kategorie-filter')?.value || 'ALLE';
    const comboFilter = $('ort-filter-combo')?.value || '';
    const suchText = $('such-filter')?.value.toLowerCase().trim() || '';

    let ortFilter = 'ALLE', regalTemp = '';
    if (comboFilter.startsWith('ort:')) ortFilter = comboFilter.substring(4);
    else if (comboFilter.startsWith('regal:')) regalTemp = comboFilter.substring(6);

    aktiverRegalFilter = regalTemp || (comboFilter === '' ? '' : aktiverRegalFilter);

    let gefiltert = aktuelleDaten.filter(z => {
        if (suchText) {
            const matches = [z.artikel?.name, z.artikel?.kategorie, z.lagerorte?.name, String(z.artikel?.id ?? '')]
                .some(field => (field || '').toLowerCase().includes(suchText));
            if (!matches) return false;
        }
        if (aktiverRegalFilter && ![z.artikel?.name, z.artikel?.kategorie, z.lagerorte?.name].some(t => textEnthaeltRegal(t, aktiverRegalFilter))) return false;
        if (katFilter !== 'ALLE' && z.artikel?.kategorie !== katFilter) return false;
        if (ortFilter !== 'ALLE' && String(z.lagerort_id) !== String(ortFilter)) return false;
        return true;
    });

    tabelleAktualisieren(gefiltert);
}

function ortComboChanged() {
    const val = $('ort-filter-combo')?.value || '';
    if (val.startsWith('regal:')) {
        aktiverRegalFilter = val.substring(6);
    } else {
        aktiverRegalFilter = '';
    }
    wendeFilterAn();
}

function toggleSortierung() {
    sortAscending = !sortAscending;
    $('btn-sort').innerText = sortAscending ? 'A-Z' : 'Z-A';
    wendeFilterAn();
}

function toggleGruppe(name) {
    if (offeneGruppen.has(name)) offeneGruppen.delete(name); else offeneGruppen.add(name);
    wendeFilterAn();
}
function toggleAlleGruppen() {
    isAllOpen = !isAllOpen;
    offeneGruppen.clear();
    if (isAllOpen) aktuelleDaten.forEach(z => { if (z.artikel) offeneGruppen.add(z.artikel.kategorie || 'Ohne Kategorie'); });
    wendeFilterAn();
}
function toggleAlleArtikelSichtbarkeit() {
    zeigeAlleArtikel = !zeigeAlleArtikel;
    wendeFilterAn();
}

function tabelleAktualisieren(daten) {
    const tbody = $('lager-tabelle');
    if (!tbody) return;
    tbody.innerHTML = '';

    const suchText = $('such-filter')?.value.trim() || '';
    const isSearching = suchText.length > 0 || aktiverRegalFilter !== '';

    // Reservierungen aus Packlisten berechnen
    const resMap = {};
    packlistenPositionen.forEach(p => {
        if (!p.artikel_id) return;
        if (!resMap[p.artikel_id]) resMap[p.artikel_id] = { gesamt: 0, listen: {} };
        resMap[p.artikel_id].gesamt += Number(p.menge);
        const pl = packlisten.find(l => String(l.id) === String(p.packliste_id));
        const plName = pl ? pl.name : 'Unbekannt';
        resMap[p.artikel_id].listen[plName] = (resMap[p.artikel_id].listen[plName] || 0) + Number(p.menge);
    });

    // Markierte vs. Alle Artikel filtern
    const anzeigeDaten = (zeigeAlleArtikel || isSearching) ? daten : daten.filter(z => z.artikel?.wichtig);

    const gruppen = {};
    anzeigeDaten.forEach(z => {
        if (!z.artikel) return;
        const kat = z.artikel.kategorie || 'Ohne Kategorie';
        if (!gruppen[kat]) gruppen[kat] = [];
        gruppen[kat].push(z);
    });

    const sortFactor = sortAscending ? 1 : -1;
    const sortedKategorien = Object.keys(gruppen).sort((a, b) => {
        if (a === 'Ohne Kategorie') return 1;
        if (b === 'Ohne Kategorie') return -1;
        return a.localeCompare(b, 'de') * sortFactor;
    });

    if (anzeigeDaten.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:25px; color:#666;">${zeigeAlleArtikel ? 'Keine Artikel vorhanden.' : 'Keine markierten Artikel vorhanden.'}</td></tr>`;
        return;
    }

    sortedKategorien.forEach(katName => {
        const zeilen = gruppen[katName];
        const isOpen = offeneGruppen.has(katName) || isSearching;

        let ordnerSumme = 0, hatUnendlich = false;
        zeilen.forEach(z => {
            if (Number(z.menge) === -1) hatUnendlich = true;
            else if (Number(z.menge) >= 0) ordnerSumme += Number(z.menge);
        });
        const sumText = hatUnendlich ? (ordnerSumme > 0 ? `${ordnerSumme} + ∞` : '∞') : ordnerSumme;

        const headerTr = document.createElement('tr');
        headerTr.style.cursor = 'pointer';
        headerTr.onclick = () => toggleGruppe(katName);
        headerTr.innerHTML = `
            <td colspan="3" style="background-color:#e2e8f0; color:#2c3e50; font-weight:bold; padding:12px; user-select:none;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>${isOpen ? '📂' : '📁'} ${escapeHtml(katName)}</span>
                    <span class="summen-badge">Gesamt: ${sumText}</span>
                </div>
            </td>`;
        tbody.appendChild(headerTr);
        if (!isOpen) return;

        // Prefix-Gruppierung vorbereiten
        const prefixCounts = {}, prefixSums = {}, prefixInf = {};
        zeilen.forEach(z => {
            const parts = z.artikel.name.trim().split(' ');
            if (parts.length > 1) {
                const pref = parts[0];
                prefixCounts[pref] = (prefixCounts[pref] || 0) + 1;
                if (Number(z.menge) === -1) prefixInf[pref] = true;
                else if (Number(z.menge) >= 0) prefixSums[pref] = (prefixSums[pref] || 0) + Number(z.menge);
            }
        });

        // Nach Artikel gruppieren
        const artMap = new Map();
        zeilen.forEach(z => {
            if (!artMap.has(z.artikel_id)) artMap.set(z.artikel_id, { artikel: z.artikel, bestaende: [] });
            artMap.get(z.artikel_id).bestaende.push(z);
        });

        const sortierteArtikel = Array.from(artMap.entries()).map(([artId, grp]) => ({
            artId, grp,
            sortRegal: ermittleRegalSchluessel(grp.bestaende),
            sortName: grp.artikel.name.trim()
        })).sort((a, b) => {
            const regalCmp = vergleicheRegalNamen(a.sortRegal, b.sortRegal, sortFactor);
            return regalCmp !== 0 ? regalCmp : a.sortName.localeCompare(b.sortName, 'de', { numeric: true }) * sortFactor;
        });

        let currentPrefix = null;
        sortierteArtikel.forEach(({ grp, artId }) => {
            grp.bestaende.sort((a, b) => vergleicheRegalNamen(a.lagerorte?.name || '', b.lagerorte?.name || '', sortFactor));
            const parts = grp.artikel.name.trim().split(' ');
            const isGrp = parts.length > 1 && prefixCounts[parts[0]] > 1;
            const pref = isGrp ? parts[0] : null;

            // Prefix-Zwischenüberschrift einfügen
            if (isGrp && currentPrefix !== pref) {
                const pSum = prefixSums[pref] || 0;
                const pInf = prefixInf[pref];
                const pText = pInf ? (pSum > 0 ? `${pSum} + ∞` : '∞') : pSum;
                const subTr = document.createElement('tr');
                subTr.innerHTML = `
                    <td colspan="3" style="padding-left:25px; background:#fafafa; color:#7f8c8d; font-size:0.85em; font-weight:bold; border-bottom:1px dashed #ddd; user-select:none;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span>🏷️ ${escapeHtml(pref)}</span>
                            <span class="sub-sum-badge">Gesamt: ${pText}</span>
                        </div>
                    </td>`;
                tbody.appendChild(subTr);
                currentPrefix = pref;
            } else if (!isGrp) currentPrefix = null;

            const tr = document.createElement('tr');
            tr.style.cursor = isEditMode ? 'pointer' : 'default';
            tr.onclick = (e) => {
                if (!['INPUT', 'BUTTON', 'SVG', 'PATH'].includes(e.target.tagName)) openEditModal(artId);
            };

            const displayName = isGrp ? grp.artikel.name.trim().substring(pref.length).trim() : grp.artikel.name;
            const wichtigBadge = grp.artikel.wichtig ? '<span class="badge-markiert">MARKIERT</span>' : '';
            const hatKommentar = Boolean(grp.artikel.kommentar?.trim());
            const kommentarIcon = isEditMode ? `
                <span onclick="openKommentarModal('${artId}', event)" style="cursor:pointer; margin-left:8px; vertical-align:middle; opacity:${hatKommentar ? '1' : '0.5'};" title="Notiz bearbeiten">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="${hatKommentar ? '#3498db' : 'none'}" stroke="${hatKommentar ? '#3498db' : '#bdc3c7'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                </span>` : '';
            const kommentarAnzeige = !isEditMode && hatKommentar ? `
                <div class="bestand-kommentar-anzeige">
                    <span style="color:#3498db;">💬</span>
                    <span style="word-break:break-word;">${escapeHtml(grp.artikel.kommentar.trim())}</span>
                </div>` : '';

            let resHtml = '';
            const res = resMap[artId];
            if (res && res.gesamt > 0) {
                let hoverText = '<strong>Reserviert für:</strong><br>' + Object.entries(res.listen).map(([l, m]) => `• ${m}x in <i>${escapeHtml(l)}</i><br>`).join('');
                resHtml = `<div class="bestand-reserviert-info" data-hover-type="res" data-hover-content="${hoverText}" onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)">📦 Reserviert: ${res.gesamt}</div>`;
            }

            const einheit = grp.artikel.einheit || 'Stück';
            let bestandRowsHtml = grp.bestaende.map(b => {
                const m = Number(b.menge);
                let zelle = '';
                if (m === -1) zelle = `<span style="font-size:1.2em; color:#7f8c8d; font-weight:bold;">∞</span> <small class="bestand-einheit">${einheit}</small>`;
                else if (m === -2 || m === -3) zelle = `<span class="bestand-status-pill ${m === -3 ? 'warn' : 'ok'}">-</span>`;
                else {
                    zelle = `
                        <div class="bestand-ort-qty-wrap">
                            <input type="text" id="menge-${b.id}" class="menge-input bestand-menge-input ${m > 0 ? 'bestand-menge-ok' : 'bestand-menge-low'}" value="${b.menge}" onchange="speichereMenge(${b.id})" oninput="aktualisiereMengeEingabeFarbe(this)" style="width:60px;">
                            <small class="bestand-einheit">${einheit}</small>
                        </div>`;
                }
                return `<div class="bestand-ort-row"><span class="bestand-ort-name">📍 ${escapeHtml(b.lagerorte?.name || '')}</span>${zelle}</div>`;
            }).join('');

            let latestDate = null;
            grp.bestaende.forEach(b => { if (b.created_at && (!latestDate || new Date(b.created_at) > latestDate)) latestDate = new Date(b.created_at); });
            const dateStr = latestDate ? latestDate.toLocaleDateString('de-DE') + ' ' + latestDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : 'Unbekannt';

            tr.innerHTML = `
                <td style="padding-left:${isGrp ? 45 : 25}px;" data-hover-type="date" data-hover-content="${dateStr}" onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)">
                    ${isGrp ? '◦' : '↳'} <strong>${escapeHtml(displayName)}</strong>${wichtigBadge}${kommentarIcon}${kommentarAnzeige}
                    <div style="font-size:0.7em; color:#b0b0b0; margin-top:2px;">ID: ${formatArtikelId(grp.artikel.id)}</div>
                    ${resHtml ? `<div style="margin-top:3px;">${resHtml}</div>` : ''}
                </td>
                <td colspan="2">${bestandRowsHtml}</td>`;
            tbody.appendChild(tr);
        });
    });

    // Button für mehr/weniger Artikel
    const hiddenCount = aktuelleDaten.filter(z => z.artikel && !z.artikel.wichtig).length;
    if (hiddenCount > 0 && !isSearching) {
        const footTr = document.createElement('tr');
        footTr.innerHTML = `
            <td colspan="3" style="padding:14px; text-align:center; background:#f8fafc; border-top:1px solid #dfe6e9;">
                <button class="btn" onclick="toggleAlleArtikelSichtbarkeit()" style="background:#34495e; width:auto; min-width:220px;">
                    ${zeigeAlleArtikel ? 'Weniger anzeigen' : `Mehr anzeigen (${hiddenCount} weitere)`}
                </button>
            </td>`;
        tbody.appendChild(footTr);
    }
}

// Speichert das Mengenfeld (inkl. Rechner & Strich-Unterstützung)
async function speichereMenge(bId) {
    const f = $(`menge-${bId}`);
    if (!f) return;
    const val = f.value.trim();
    let neueMenge;
    if (val === '∞') neueMenge = -1;
    else if (val === '-') neueMenge = BESTAND_STRICH_AUSREICHEND;
    else neueMenge = werteMengeAus(val);

    f.value = neueMenge === -1 ? '∞' : (neueMenge < 0 ? '-' : neueMenge);
    aktualisiereMengeEingabeFarbe(f);
    f.style.backgroundColor = '#fff3cd';

    const datum = new Date().toISOString();
    let { error } = await dbClient.from('bestand').update({ menge: neueMenge, created_at: datum }).eq('id', bId);
    if (!error) {
        f.style.backgroundColor = '#d4edda';
        showToast(`Bestand gespeichert: ${f.value}`);
        setTimeout(() => { if (f) f.style.backgroundColor = ''; ladeAlles(); }, 800);
    } else showToast('Speicherfehler!', 'error');
}

// Tooltip-Events
window.handleMouseEnter = (e) => {
    const t = e.currentTarget;
    if (t.dataset.hoverType === 'date') { $('hover-date-text').innerHTML = t.dataset.hoverContent; $('hover-date-info').style.display = 'block'; }
    if (t.dataset.hoverType === 'res') { $('hover-res-text').innerHTML = t.dataset.hoverContent; $('hover-res-info').style.display = 'block'; }
};
window.handleMouseLeave = () => { $('hover-date-info').style.display = 'none'; $('hover-res-info').style.display = 'none'; };

// =========================================================================
// 9. KISTEN-ANSICHT & ORTE VERWALTEN
// =========================================================================

function renderKistenListe() {
    const ziel = $('kisten-tabelle');
    if (!ziel) return;

    const filter = ($('kisten-such-filter')?.value || '').toLowerCase().trim();
    const liste = alleLagerorte.filter(o => !filter || o.name.toLowerCase().includes(filter) || (o.nfc_code || '').toLowerCase().includes(filter));

    if (!liste.length) {
        ziel.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Keine Kisten gefunden.</td></tr>';
        return;
    }

    ziel.innerHTML = liste.map(o => {
        const bestand = gibKistenBestand(o.id);
        const fehlt = bestand.some(b => Number(b.soll_menge) > 0 && Number(b.menge) < Number(b.soll_menge));

        return `
            <tr>
                <td><strong>${escapeHtml(o.name)}</strong><br><small style="color:#7f8c8d;">${escapeHtml(o.nfc_code || 'Kein Tag')}</small></td>
                <td>${bestand.length} Artikel</td>
                <td>${fehlt ? '<span style="color:#c0392b; font-weight:bold;">🔴 Teile fehlen</span>' : '<span style="color:#27ae60; font-weight:bold;">✔️ Vollzählig</span>'}</td>
                <td>
                    <button class="btn" style="background:#16a085; padding:8px 12px; width:auto;" onclick="oeffneKistenCheck(${o.id})">📦 Inhalt / Prüfen</button>
                    <button class="btn" style="background:#3498db; padding:8px 12px; width:auto;" onclick="openOrteVerwalten(${o.id})">⚙️</button>
                </td>
            </tr>`;
    }).join('');
}

function openNeuOrtModal() { $('neu-ort-name').value = ''; openModalById('neuOrtModal'); }
async function speichereNeuenOrt() {
    const name = $('neu-ort-name').value.trim();
    if (!name) return;
    await dbClient.from('lagerorte').insert([{ name }]);
    closeModal('neuOrtModal');
    showToast('Lagerort angelegt!');
    await ladeAlles();
}

function openOrteVerwalten(preselectId = null) {
    populateSelect($('manage-ort-select'), alleLagerorte, { selectedValue: preselectId });
    ortSelectChanged();
    openModalById('orteModal');
}
function ortSelectChanged() {
    const selId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(selId));
    if (ort) $('manage-ort-name').value = ort.name;
    const statusEl = $('manage-ort-nfc-status'), delBtn = $('manage-ort-nfc-entfernen-btn');
    if (statusEl) statusEl.textContent = ort?.nfc_code ? `Aktueller Code: ${ort.nfc_code}` : 'Noch kein NFC-Tag verknüpft.';
    if (delBtn) delBtn.style.display = ort?.nfc_code ? 'block' : 'none';
}
async function speichereOrt() {
    const oId = $('manage-ort-select').value, nName = $('manage-ort-name').value.trim();
    if (!oId || !nName) return;
    await dbClient.from('lagerorte').update({ name: nName }).eq('id', oId);
    closeModal('orteModal');
    showToast('Lagerort umbenannt!');
    await ladeAlles();
}
async function entferneNfcVonOrt() {
    const oId = $('manage-ort-select').value;
    await dbClient.from('lagerorte').update({ nfc_code: null }).eq('id', oId);
    showToast('NFC-Tag entfernt.');
    await ladeAlles();
    ortSelectChanged();
}

// =========================================================================
// 10. ARTIKEL ANLEGEN & BEARBEITEN (MIT ORIGINAL-MENGENSYSTEM)
// =========================================================================
function toggleEditMode() {
    isEditMode = !isEditMode;
    $('btn-edit-mode').innerText = isEditMode ? '✏️ Bearbeiten: AN' : '✏️ Bearbeiten: AUS';
    $('btn-edit-mode').style.backgroundColor = isEditMode ? '#e67e22' : '#f39c12';
    document.querySelectorAll('.lager-edit-only').forEach(el => el.style.display = isEditMode ? '' : 'none');
    wendeFilterAn();
}

function openModal() {
    $('new-name').value = '';
    $('new-kategorie').value = '';
    $('new-einheit').value = 'Stück';
    if ($('new-wichtig')) $('new-wichtig').checked = false;
    if ($('new-typ')) $('new-typ').value = 'zaehlbar';

    const wrapper = $('new-orte-wrapper');
    const rows = wrapper.querySelectorAll('.lagerort-row');
    for (let i = 1; i < rows.length; i++) rows[i].remove();

    const first = rows[0];
    const input = first.querySelector('.new-menge');
    input.value = '0';
    aktualisiereMengeEingabeFarbe(input);
    setzeBestandStatus(first, 'zahl');

    openModalById('artikelModal');
}

function addOrtRow() {
    const wrapper = $('new-orte-wrapper');
    const newRow = wrapper.querySelector('.lagerort-row').cloneNode(true);
    const input = newRow.querySelector('.new-menge');
    input.value = '0';
    aktualisiereMengeEingabeFarbe(input);
    setzeBestandStatus(newRow, 'zahl');
    wrapper.appendChild(newRow);
}

function removeNewOrtRow(btn) {
    const wrapper = $('new-orte-wrapper');
    if (wrapper.querySelectorAll('.lagerort-row').length > 1) btn.closest('.lagerort-row').remove();
    else showToast('Ein Artikel muss mindestens einen Lagerort haben!', 'warning');
}

async function artikelAnlegen() {
    const name = $('new-name').value.trim(), kat = $('new-kategorie').value.trim(), einheit = $('new-einheit').value;
    const wichtig = Boolean($('new-wichtig')?.checked), typ = $('new-typ')?.value || 'zaehlbar';
    if (!name) return showToast('Bitte Namen eingeben.', 'warning');

    const { data, error } = await dbClient.from('artikel').insert([{ name, kategorie: kat, einheit, wichtig, typ }]).select();
    if (error) return showToast('Fehler: ' + error.message, 'error');

    const inserts = Array.from(document.querySelectorAll('#new-orte-wrapper .lagerort-row')).map(row => {
        const menge = leseBestandswertAusZeile(row);
        const oldVal = werteMengeAus(row.querySelector('.new-menge')?.getAttribute('data-old-value') || '0');
        return {
            artikel_id: data[0].id,
            lagerort_id: row.querySelector('.new-ort').value,
            menge,
            alte_menge: menge < 0 ? oldVal : menge
        };
    });

    if (inserts.length) await dbClient.from('bestand').insert(inserts);
    closeModal('artikelModal');
    showToast('Artikel gespeichert!');
    await ladeAlles();
}

function addEditOrtRow(data = null) {
    const wrapper = $('edit-orte-wrapper');
    const div = document.createElement('div');
    div.className = 'edit-ort-row';
    div.style = 'display:flex; gap:8px; margin-bottom:8px; align-items:center;';

    const options = alleLagerorte.map(o => `<option value="${o.id}" ${(data?.lagerort_id == o.id) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('');

    let displayVal = '0', status = 'zahl';
    if (data) {
        if (data.menge == -1) { displayVal = '∞'; status = 'inf'; }
        else if (data.menge == -2) { displayVal = '-'; status = 'strich-ok'; }
        else if (data.menge == -3) { displayVal = '-'; status = 'strich-warn'; }
        else displayVal = data.menge;
    }

    div.innerHTML = `
        <div class="bestand-row-stack" style="width:100%;">
            <select class="edit-ort-select" style="width:100%; padding:10px; border-radius:6px; border:1px solid #ccc;">${options}</select>
            <div class="bestand-action-row" style="flex-wrap:nowrap; width:100%;">
                <input type="text" class="edit-menge-input bestand-menge-input bestand-form-quantity" value="${displayVal}" data-old-value="${data?.alte_menge ?? 0}" oninput="bestandEingabeGeaendert(this)" style="flex:1.25; min-width:0; padding:12px; border-radius:6px; border:1px solid #ccc; text-align:center;">
                <button type="button" class="btn bestand-mode-btn bestand-btn-inf" style="background:#95a5a6; padding:10px; width:auto; min-width:68px; font-weight:bold;" onclick="toggleBestandInf(this)">∞</button>
                <button type="button" class="btn bestand-mode-btn bestand-btn-minus" style="background:#95a5a6; padding:10px; width:auto; min-width:44px; font-weight:bold;" onclick="toggleBestandMinus(this)">-</button>
            </div>
            <label class="bestand-nachkauf-wrap"><input type="checkbox" class="bestand-nachkauf-checkbox" onchange="toggleNachkaufCheckbox(this)"><span>Auf Nachkaufen setzen</span></label>
        </div>
        <button type="button" class="btn" style="background:#e74c3c; padding:8px 12px; width:auto;" onclick="this.closest('.edit-ort-row').remove()">🗑️</button>`;
    
    setzeBestandStatus(div, status, status === 'strich-warn');
    wrapper.appendChild(div);
}

async function openEditModal(artikelId) {
    if (!isEditMode) return;
    const art = alleArtikelInfos.find(a => a.id === artikelId);
    const bestaende = aktuelleDaten.filter(b => b.artikel_id === artikelId);

    $('edit-artikel-id').value = artikelId;
    $('edit-name').value = art.name;
    $('edit-kategorie').value = art.kategorie || '';
    $('edit-einheit').value = art.einheit || 'Stück';
    $('edit-typ').value = art.typ || 'zaehlbar';
    $('edit-wichtig').checked = Boolean(art.wichtig);

    const wrapper = $('edit-orte-wrapper');
    wrapper.innerHTML = '';
    if (bestaende.length) bestaende.forEach(b => addEditOrtRow(b));
    else addEditOrtRow();

    openModalById('editModal');
}

async function speichereBearbeitung() {
    const aid = $('edit-artikel-id').value;
    const name = $('edit-name').value.trim(), kat = $('edit-kategorie').value.trim(), einheit = $('edit-einheit').value;
    const typ = $('edit-typ').value, wichtig = $('edit-wichtig').checked;

    await dbClient.from('artikel').update({ name, kategorie: kat, einheit, typ, wichtig }).eq('id', aid);
    await dbClient.from('bestand').delete().eq('artikel_id', aid);

    const inserts = Array.from(document.querySelectorAll('#edit-orte-wrapper .edit-ort-row')).map(row => {
        const oid = row.querySelector('.edit-ort-select').value;
        const menge = leseBestandswertAusZeile(row);
        const oldVal = werteMengeAus(row.querySelector('.edit-menge-input')?.getAttribute('data-old-value') || '0');
        return {
            artikel_id: Number(aid),
            lagerort_id: Number(oid),
            menge,
            alte_menge: menge < 0 ? oldVal : menge
        };
    });

    if (inserts.length) await dbClient.from('bestand').insert(inserts);
    closeModal('editModal');
    showToast('Artikel aktualisiert!');
    await ladeAlles();
}

async function artikelLoeschen() {
    if (!confirm('Diesen Artikel wirklich komplett löschen?')) return;
    const aid = $('edit-artikel-id').value;
    await dbClient.from('bestand').delete().eq('artikel_id', aid);
    await dbClient.from('artikel').delete().eq('id', aid);
    closeModal('editModal');
    showToast('Artikel gelöscht.');
    await ladeAlles();
}

function openKommentarModal(artikelId, event) {
    if (event) event.stopPropagation();
    const art = alleArtikelInfos.find(a => String(a.id) === String(artikelId));
    if (!art) return;
    $('kommentar-artikel-id').value = artikelId;
    $('kommentar-artikel-name').innerText = art.name;
    $('kommentar-text').value = art.kommentar || '';
    openModalById('kommentarModal');
}
async function speichereKommentar() {
    const aid = $('kommentar-artikel-id').value, text = $('kommentar-text').value;
    await dbClient.from('artikel').update({ kommentar: text }).eq('id', aid);
    closeModal('kommentarModal');
    showToast('Notiz gespeichert!');
    ladeAlles();
}

// =========================================================================
// 11. EVENT-MODUS & PACKLISTEN & EXCEL
// =========================================================================
function wechsleModus(modus) {
    aktuellerModus = modus;
    ['lager', 'kisten', 'event'].forEach(m => {
        const v = $(`ansicht-${m}`), t = $(`tab-${m}`);
        if (v) v.style.display = m === modus ? 'block' : 'none';
        if (t) t.className = m === modus ? 'btn btn-modus active' : 'btn btn-modus';
    });
    if (modus === 'kisten') renderKistenListe();
    if (modus === 'event') zeigePackliste();
}

function zeigePackliste() {
    const currentId = $('packlisten-auswahl')?.value;
    const details = $('packliste-details'), tbody = $('event-tabelle');
    if (!tbody || !details) return;
    tbody.innerHTML = '';
    if (!currentId) { details.style.display = 'none'; return; }
    details.style.display = 'block';

    const positionen = packlistenPositionen.filter(p => String(p.packliste_id) === String(currentId));
    if (!positionen.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Noch keine Positionen in dieser Packliste.</td></tr>';
        return;
    }

    positionen.forEach(pos => {
        let name = pos.artikel?.name || pos.eigener_name || 'Unbekannt';
        let verfuegbar = '-';
        let status = '<span class="event-ok">✅ OK</span>';

        if (pos.artikel_id) {
            const bestandArtikel = aktuelleDaten.filter(b => b.artikel_id === pos.artikel_id);
            verfuegbar = bestandArtikel.reduce((sum, b) => sum + (Number(b.menge) >= 0 ? Number(b.menge) : 0), 0);
            if (verfuegbar < pos.menge) status = `<span class="event-warning">❌ Zu wenig (${verfuegbar - pos.menge})</span>`;
        }

        let actionCell = isEventEditMode ? `<button class="btn" style="background:#e74c3c; padding:4px 8px; font-size:0.8em; margin-left:8px;" onclick="loeschePackPosition(${pos.id})">🗑️</button>` : '';

        tbody.innerHTML += `
            <tr>
                <td><strong>${escapeHtml(name)}</strong></td>
                <td>${pos.menge}</td>
                <td>${verfuegbar}</td>
                <td>${status} ${actionCell}</td>
            </tr>`;
    });
}

function toggleEventEditMode() {
    isEventEditMode = !isEventEditMode;
    $('btn-event-edit').innerText = isEventEditMode ? '✏️ Bearbeiten: AN' : '✏️ Bearbeiten: AUS';
    $('btn-event-edit').style.backgroundColor = isEventEditMode ? '#e67e22' : '#f39c12';
    document.querySelectorAll('.event-edit-only').forEach(el => el.style.display = isEventEditMode ? '' : 'none');
    zeigePackliste();
}

function openPackItemModal() {
    if (!$('packlisten-auswahl')?.value) return showToast('Bitte wähle zuerst eine Packliste aus.', 'warning');
    $('pack-artikel-input').value = '';
    $('pack-eigener-name').value = '';
    $('pack-menge').value = '1';
    openModalById('packItemModal');
}

function togglePackTyp() {
    const t = $('pack-typ').value;
    $('div-pack-lager').style.display = t === 'lager' ? 'block' : 'none';
    $('div-pack-custom').style.display = t === 'custom' ? 'block' : 'none';
}

async function packPositionSpeichern() {
    const plId = $('packlisten-auswahl').value;
    const typ = $('pack-typ').value;
    const menge = werteMengeAus($('pack-menge').value) || 1;

    const payload = { packliste_id: Number(plId), menge };

    if (typ === 'lager') {
        const artName = $('pack-artikel-input').value.trim();
        const art = alleArtikelInfos.find(a => a.name.toLowerCase() === artName.toLowerCase());
        if (!art) return showToast('Artikel nicht im Lager gefunden.', 'warning');
        payload.artikel_id = art.id;
    } else {
        const cName = $('pack-eigener-name').value.trim();
        if (!cName) return showToast('Bitte Namen eingeben.', 'warning');
        payload.eigener_name = cName;
    }

    await dbClient.from('packlisten_positionen').insert([payload]);
    closeModal('packItemModal');
    showToast('Position hinzugefügt!');
    await ladePacklistenDaten();
    zeigePackliste();
}

async function loeschePackPosition(posId) {
    if (!confirm('Position aus Packliste löschen?')) return;
    await dbClient.from('packlisten_positionen').delete().eq('id', posId);
    await ladePacklistenDaten();
    zeigePackliste();
}

async function neuePacklisteAnlegen() {
    const n = prompt('Name der neuen Packliste:');
    if (!n?.trim()) return;
    await dbClient.from('packlisten').insert([{ name: n.trim() }]);
    await ladePacklistenDaten();
}
async function umbenennePackliste() {
    const id = $('packlisten-auswahl').value;
    const cur = packlisten.find(p => String(p.id) === String(id));
    const n = prompt('Neuer Name:', cur?.name);
    if (n?.trim() && n !== cur.name) {
        await dbClient.from('packlisten').update({ name: n.trim() }).eq('id', id);
        await ladePacklistenDaten();
    }
}
async function loeschePackliste() {
    const id = $('packlisten-auswahl').value;
    if (!confirm('Packliste wirklich löschen?')) return;
    await dbClient.from('packlisten').delete().eq('id', id);
    $('packlisten-auswahl').value = '';
    await ladePacklistenDaten();
    zeigePackliste();
}

function druckePackliste() {
    const listId = $('packlisten-auswahl').value;
    if (!listId) return;
    const pl = packlisten.find(p => String(p.id) === String(listId));
    const pos = packlistenPositionen.filter(p => String(p.packliste_id) === String(listId));

    const win = window.open('', '_blank');
    const rowsHtml = pos.map(p => {
        const art = p.artikel?.name || p.eigener_name;
        const ort = p.artikel_id ? (aktuelleDaten.filter(b => b.artikel_id === p.artikel_id).map(b => b.lagerorte?.name).join(', ') || '-') : 'Sonderposten';
        return `<tr><td style="width:30px; text-align:center;"><input type="checkbox"></td><td><strong>${escapeHtml(art)}</strong></td><td>${p.menge}</td><td>${escapeHtml(ort)}</td></tr>`;
    }).join('');

    win.document.write(`
        <html><head><title>Packliste: ${escapeHtml(pl.name)}</title>
        <style>body{font-family:sans-serif; padding:20px;} table{width:100%; border-collapse:collapse; margin-top:15px;} th,td{border:1px solid #ccc; padding:8px; text-align:left;} th{background:#eee;} @media print{.no-p{display:none;}}</style>
        </head><body>
            <button class="no-p" onclick="window.print()" style="padding:10px; margin-bottom:15px; cursor:pointer;">🖨️ Drucken</button>
            <h1>📦 Packliste: ${escapeHtml(pl.name)}</h1>
            <table><thead><tr><th>OK</th><th>Gegenstand</th><th>Menge</th><th>Lagerort</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        </body></html>`);
    win.document.close();
}

function startEinkaufsliste() {
    const autoListe = [];
    const sonderListe = [];
    einkaufslisteArray = [];

    const bestandMap = {};
    aktuelleDaten.forEach(b => {
        const m = Number(b.menge);
        if (m >= 0) bestandMap[b.artikel_id] = (bestandMap[b.artikel_id] || 0) + m;
    });

    const bedarfMap = {};
    packlistenPositionen.forEach(p => {
        if (p.artikel_id) bedarfMap[p.artikel_id] = (bedarfMap[p.artikel_id] || 0) + Number(p.menge);
        else if (p.eigener_name) sonderListe.push({ artikel: p.eigener_name, menge: p.menge, grund: 'Packliste Sonderposten' });
    });

    alleArtikelInfos.forEach(art => {
        const bedarf = bedarfMap[art.id] || 0;
        const ist = bestandMap[art.id] || 0;
        if (bedarf > ist) autoListe.push({ artikel: art.name, menge: bedarf - ist, grund: 'Fehlt für Packliste' });
    });

    einkaufslisteArray = [...autoListe, ...sonderListe];

    $('auto-kauf-liste').innerHTML = autoListe.length ? autoListe.map(i => `<li>${i.menge}x ${escapeHtml(i.artikel)}</li>`).join('') : '<li>Keine Fehlmengen.</li>';
    $('eigene-kauf-liste').innerHTML = sonderListe.length ? sonderListe.map(i => `<li>${i.menge}x ${escapeHtml(i.artikel)}</li>`).join('') : '<li>Keine Sonderposten.</li>';
    openModalById('kauflisteModal');
}

async function downloadExcel() {
    if (!einkaufslisteArray.length) return showToast('Die Liste ist leer.', 'warning');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Einkaufsliste');

    ws.addRow(['EINKAUFSLISTE - TRISPORT ERDING']);
    ws.addRow(['Erstellt am: ' + new Date().toLocaleString('de-DE')]);
    ws.addRow([]);
    ws.addRow(['ARTIKEL / GEGENSTAND', 'MENGE', 'HINWEIS']);

    einkaufslisteArray.forEach(i => ws.addRow([i.artikel, i.menge, i.grund]));
    ws.getColumn(1).width = 40; ws.getColumn(2).width = 12; ws.getColumn(3).width = 30;

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `Einkaufsliste_${new Date().toISOString().split('T')[0]}.xlsx`;
    a.click();
    closeModal('kauflisteModal');
}

// =========================================================================
// 12. ETIKETTEN- & QR-TOOLS, FEEDBACK
// =========================================================================

function oeffneEtikettenTool() { window.open('?etiketten=1', '_blank'); }
function oeffneQrGeneratorFenster() { window.open('?qrgen=1', '_blank'); }

function renderArtikelEtikettenListe() {
    const ziel = $('etiketten-liste');
    if (!ziel) return;
    const filter = ($('etiketten-suche')?.value || '').toLowerCase().trim();
    const liste = alleArtikelInfos.filter(a => !filter || a.name.toLowerCase().includes(filter));

    ziel.innerHTML = liste.map(art => {
        const chk = etikettenAuswahlIds.has(String(art.id));
        return `
            <div class="etikett-zeile ${chk ? 'ist-ausgewaehlt' : ''}">
                <input type="checkbox" ${chk ? 'checked' : ''} onchange="toggleEtikettAuswahl('${art.id}', this.checked)">
                <div class="etikett-qr" id="etikett-qr-${art.id}"></div>
                <div style="flex:1;"><strong>${escapeHtml(art.name)}</strong><br><small>${escapeHtml(art.kategorie || '')} &bull; ${formatArtikelId(art.id)}</small></div>
            </div>`;
    }).join('') || '<p style="text-align:center;">Keine Artikel.</p>';

    liste.forEach(art => {
        const c = $(`etikett-qr-${art.id}`);
        if (c) new QRCode(c, { text: `https://trilager.pius-s.de?rueckgabe=${art.id}`, width: 90, height: 90 });
    });
}

function toggleEtikettAuswahl(id, chk) {
    if (chk) etikettenAuswahlIds.add(String(id)); else etikettenAuswahlIds.delete(String(id));
    $('etiketten-auswahl-count').textContent = etikettenAuswahlIds.size;
    $('etiketten-auswahl-drucken-btn').disabled = !etikettenAuswahlIds.size;
}
function toggleAlleEtikettenAuswahl(chk) {
    alleArtikelInfos.forEach(a => toggleEtikettAuswahl(a.id, chk));
    renderArtikelEtikettenListe();
}

function druckeAusgewaehlteEtiketten() { druckeEtiketten(alleArtikelInfos.filter(a => etikettenAuswahlIds.has(String(a.id)))); }
function druckeAlleEtiketten() { druckeEtiketten(alleArtikelInfos); }

function druckeEtiketten(liste) {
    const win = window.open('', '_blank');
    const items = liste.map(a => `
        <div style="width:42mm; display:flex; flex-direction:column; align-items:center; padding:3mm; border:1px dashed #bbb; page-break-inside:avoid; text-align:center;">
            <div class="p-qr" data-link="https://trilager.pius-s.de?rueckgabe=${a.id}"></div>
            <div style="font-size:11px; font-weight:bold; margin-top:2mm;">${escapeHtml(a.name)}</div>
            <div style="font-size:9px; color:#666;">${formatArtikelId(a.id)}</div>
        </div>`).join('');

    win.document.write(`
        <html><head><title>Etiketten drucken</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
        <style>body{margin:0; padding:10mm; display:grid; grid-template-columns:repeat(4, 1fr); gap:5mm; font-family:sans-serif;} @media print{.no-p{display:none;}}</style>
        </head><body>
            <button class="no-p" onclick="window.print()" style="position:fixed; top:10px; right:10px; padding:10px;">🖨️ Drucken</button>
            ${items}
            <script>window.onload=function(){document.querySelectorAll('.p-qr').forEach(el=>new QRCode(el,{text:el.dataset.link,width:180,height:180}));};<\/script>
        </body></html>`);
    win.document.close();
}

function aktualisiereRegalQrVorschau() {
    const val = $('regal-qr-input')?.value.trim();
    const prev = $('regal-qr-preview'), link = $('regal-qr-link');
    if (!val) { if (prev) prev.innerHTML = ''; if (link) link.innerText = ''; return; }
    const url = `https://trilager.pius-s.de?regal=${encodeURIComponent(extrahiereRegalName(val))}`;
    prev.innerHTML = '';
    new QRCode(prev, { text: url, width: 220, height: 220 });
    link.href = url; link.innerText = url;
}
function downloadRegalQrDatei(fmt = 'png') {
    const c = $('regal-qr-preview')?.querySelector('canvas');
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `Regal_QR_${extrahiereRegalName($('regal-qr-input').value)}.${fmt}`;
    a.click();
}

async function formularAntwortSpeichern() {
    const name = $('formular-name')?.value.trim() || 'Anonym';
    const frage1 = $('formular-frage1')?.value.trim() || '';
    const frage2 = $('formular-frage2')?.value.trim() || '';
    if (!frage1 && !frage2) return showToast('Bitte mindestens eine Frage beantworten.', 'warning');
    await dbClient.from(TABLES.FORMULAR).insert([{ name, frage1, frage2 }]);
    showToast('Danke für dein Feedback!');
    $('formular-frage1').value = ''; $('formular-frage2').value = '';
}
async function formularAntwortenLaden() {
    const ziel = $('formular-antworten');
    const { data } = await dbClient.from(TABLES.FORMULAR).select('*').order('created_at', { ascending: false });
    if (!ziel) return;
    ziel.style.display = 'block';
    ziel.innerHTML = (data || []).map(e => `
        <div class="survey-answer-item">
            <strong>${escapeHtml(e.name)}</strong> &bull; <small>${new Date(e.created_at).toLocaleDateString('de-DE')}</small>
            <p><strong>Bedarf:</strong> ${escapeHtml(e.frage1)}</p>
            <p><strong>Materialien:</strong> ${escapeHtml(e.frage2)}</p>
        </div>`).join('') || '<p>Noch keine Antworten vorhanden.</p>';
}

function zurueckZurHauptseite() {
    const url = new URL(window.location.href);
    url.search = '';
    window.location.href = url.toString();
}

// =========================================================================
// 13. APP STARTUP / DOMCONTENTLOADED
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);

    if (urlParams.get('qrgen') === '1') {
        $('qrgen-ansicht').style.display = 'block';
        $('login-overlay').style.display = 'none';
        document.querySelector('.container').style.display = 'none';
        return;
    }
    if (urlParams.get('formular') === '1') {
        $('formular-ansicht').style.display = 'block';
        $('login-overlay').style.display = 'none';
        document.querySelector('.container').style.display = 'none';
        return;
    }
    if (urlParams.get('etiketten') === '1') {
        $('etiketten-ansicht').style.display = 'block';
        $('login-overlay').style.display = 'none';
        document.querySelector('.container').style.display = 'none';
        const s = holeLokaleSession();
        if (s) { setzeAuthToken(s.token); await ladeBestand(); renderArtikelEtikettenListe(); }
        return;
    }

    const session = holeLokaleSession();
    if (session) {
        setzeAuthToken(session.token);
        $('login-overlay').style.display = 'none';
        await ladeAlles();
        pruefeUndZeigeOnboarding();

        const kistenCode = urlParams.get('kistencheck');
        const rueckgabeId = urlParams.get('rueckgabe');
        if (kistenCode) verarbeiteUniversalScan('kistencheck=' + kistenCode);
        else if (rueckgabeId) verarbeiteUniversalScan('rueckgabe=' + rueckgabeId);
    } else {
        $('login-overlay').style.display = 'flex';
    }
});
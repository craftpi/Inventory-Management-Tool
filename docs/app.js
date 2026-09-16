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

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_DURATION_MS = 5 * 60 * 1000;

const TABLES = {
    FORMULAR: 'formular_antworten'
};

const BESTAND_STRICH_AUSREICHEND = -2;
const BESTAND_STRICH_NACHKAUF = -3;
const LOCAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

// App-Datenzustände
let aktuelleDaten = [], packlisten = [], packlistenPositionen = [], alleArtikelInfos = [], alleLagerorte = [];
let alleBenutzerVorlagen = [], offeneEntnahmen = [];
let isEditMode = false, isEventEditMode = false, aktuellerModus = 'lager';
let offeneGruppen = new Set(), isAllOpen = false, sortAscending = true, zeigeAlleArtikel = false;
let aktiverRegalFilter = '';
let finderFilterModus = 'fehlend';
let kistenAnsichtFilter = 'alle';
let kistenEtikettenAuswahlIds = new Set();
let einkaufslisteArray = [];
let autoFehlbestandListe = [];
let eigeneVorschlaegeListe = [];
let manuelleEintraegeListe = [];

// Kisten- & Scan-Zustände
let kistenCheckAktuelleId = '';
let aktiverQrScanner = null;
let aktiverNfcModus = null;
let nfcAbortController = null;
let scanSperre = { kisten: false, rueckgabe: false };
let hubKameraAktiv = false;
let ausbuchenPendingAktion = null;

// =========================================================================
// 2. RECHNER-PARSER & MENGEN-HILFSFUNKTIONEN
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

function openModalById(id) {
    const el = $(id);
    if (!el) return;
    el.style.display = 'block';
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('modal-visible')));
}

function closeModal(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('modal-visible');
    setTimeout(() => {
        if (!el.classList.contains('modal-visible')) el.style.display = 'none';
    }, 220);
}

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
// 3. AUTH & LOGIN-SPERRE
// =========================================================================
function pruefeLoginSperre() {
    try {
        const lockUntil = Number(window.localStorage.getItem(STORAGE_KEYS.LOCK)) || 0;
        const now = Date.now();
        if (lockUntil > now) {
            const verbleibendMs = lockUntil - now;
            const minuten = Math.ceil(verbleibendMs / 60000);
            return { gesperrt: true, minuten };
        }
        if (lockUntil > 0) {
            window.localStorage.removeItem(STORAGE_KEYS.LOCK);
            window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
        }
        return { gesperrt: false };
    } catch {
        return { gesperrt: false };
    }
}

function registriereLoginFehlversuch() {
    try {
        const attempts = (Number(window.localStorage.getItem(STORAGE_KEYS.ATTEMPTS)) || 0) + 1;
        if (attempts >= MAX_LOGIN_ATTEMPTS) {
            const lockUntil = Date.now() + LOGIN_LOCK_DURATION_MS;
            window.localStorage.setItem(STORAGE_KEYS.LOCK, String(lockUntil));
            window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
            const minuten = Math.ceil(LOGIN_LOCK_DURATION_MS / 60000);
            return { gesperrt: true, minuten };
        } else {
            window.localStorage.setItem(STORAGE_KEYS.ATTEMPTS, String(attempts));
            return { gesperrt: false, verbleibend: MAX_LOGIN_ATTEMPTS - attempts };
        }
    } catch {
        return { gesperrt: false, verbleibend: 0 };
    }
}

function loescheLoginSperre() {
    try {
        window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
        window.localStorage.removeItem(STORAGE_KEYS.LOCK);
    } catch {}
}

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
    const errEl = $('login-error');

    const sperre = pruefeLoginSperre();
    if (sperre.gesperrt) {
        if (errEl) {
            errEl.style.display = 'block';
            errEl.innerText = `Zu viele Fehlversuche! Bitte in ca. ${sperre.minuten} Minute(n) erneut versuchen.`;
        }
        return;
    }

    const p = $('login-password').value;
    if (!p) {
        if (errEl) {
            errEl.style.display = 'block';
            errEl.innerText = 'Bitte gib ein Passwort ein!';
        }
        return;
    }

    const { data, error } = await dbClient.rpc('login_user', { p_password: p });
    if (error || !data || data.length === 0) {
        const status = registriereLoginFehlversuch();
        if (errEl) {
            errEl.style.display = 'block';
            if (status.gesperrt) {
                errEl.innerText = `Zu viele Fehlversuche! Login für ${status.minuten} Minuten gesperrt.`;
            } else {
                errEl.innerText = `Falsches Passwort! Noch ${status.verbleibend} Versuch(e) übrig.`;
            }
        }
    } else {
        loescheLoginSperre();
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
    await ladeEntnahmeDaten();
    bereinigeAlteLogs();
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

    aktuelleDaten = (data || []).map(z => {
        const m = Number(z.menge);
        const alt = z.alte_menge !== null && z.alte_menge !== undefined ? Number(z.alte_menge) : null;

        let soll, ist;
        if (m === -1 || m === -2 || m === -3) {
            soll = m;
            ist = m;
        } else {
            soll = (alt !== null && alt >= 0 && alt >= m) ? alt : m;
            ist = m;
        }

        return {
            ...z,
            soll_menge: soll,
            ist_menge: ist
        };
    });

    aktualisiereFilterDropdown(aktuelleDaten);
}

async function ladeEntnahmeDaten() {
    try {
        const { data: bData } = await dbClient.from('lager_entnahme_benutzer_vorlagen').select('*').order('name');
        alleBenutzerVorlagen = bData || [];

        const { data: eData } = await dbClient.from('lager_entnahmen').select('*').order('created_at', { ascending: false });
        offeneEntnahmen = eData || [];
    } catch (err) {
        console.warn('Fehler beim Laden der Entnahmedaten:', err);
    }
}

async function bereinigeAlteLogs() {
    try {
        const einJahrVorher = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
        await dbClient.from('lager_entnahmen').delete().lt('created_at', einJahrVorher);
        await dbClient.from('lager_entnahme_audit').delete().lt('created_at', einJahrVorher).catch(() => {});
    } catch (e) {}
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
// 5. DAS VEREINHEITLICHTE KISTEN- & ENTNAHME-SYSTEM
// =========================================================================

function gibKistenBestand(lid) {
    return aktuelleDaten.filter(z => String(z.lagerort_id) === String(lid))
        .sort((a, b) => (a.artikel?.name || '').localeCompare(b.artikel?.name || '', 'de'));
}

function ermittleKistenEntnahmeStatus(lid) {
    const entnahme = offeneEntnahmen.find(e => {
        const mats = Array.isArray(e.materialien) ? e.materialien : [];
        return mats.some(m => String(m.kiste_id) === String(lid));
    });
    return entnahme || null;
}

function oeffneKistenCheck(lid) {
    const ort = alleLagerorte.find(o => String(o.id) === String(lid));
    if (!ort) return;
    kistenCheckAktuelleId = lid;

    $('kisten-check-titel').innerText = `📦 ${ort.name}`;
    $('kisten-check-code').innerText = ort.nfc_code ? `NFC/QR-Code: ${ort.nfc_code}` : 'Kein Code hinterlegt';

    const entnahme = ermittleKistenEntnahmeStatus(lid);
    const banner = $('kiste-ausgeliehen-banner');
    if (banner) {
        if (entnahme) {
            banner.style.display = 'block';
            banner.innerHTML = `⚠️ <strong>Aktuell ausgeliehen an:</strong> ${escapeHtml(entnahme.name)} (${new Date(entnahme.created_at).toLocaleString('de-DE')}) ${entnahme.kontakt ? `&bull; 📞 ${escapeHtml(entnahme.kontakt)}` : ''}`;
        } else {
            banner.style.display = 'none';
        }
    }

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
        const ist = Number(z.ist_menge);
        const soll = Number(z.soll_menge);
        const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
        const istVerbrauch = (z.artikel?.typ === 'verbrauch') || (ist < 0);
        const einheit = z.artikel?.einheit || 'Stück';

        const card = document.createElement('div');
        card.className = `kiste-item-card ${fehlt > 0 ? 'fehlend' : ''}`;

        let statusText = '';
        if (ist === -1) statusText = '<span style="font-size:1.1em; font-weight:bold; color:#7f8c8d;">∞</span> (Unbegrenzt)';
        else if (ist === -2) statusText = '<span class="bestand-status-pill ok">-</span> Ausreichend vorhanden';
        else if (ist === -3) statusText = '<span class="bestand-status-pill warn">-</span> 🔴 Nachkaufen nötig';
        else {
            statusText = `Im Lager: <strong>${ist}</strong> von max. <strong>${soll}</strong> ${einheit}`;
            if (fehlt > 0) statusText += ` &bull; <span style="color:#c0392b; font-weight:bold;">${fehlt} fehlen unterwegs</span>`;
            else statusText += ` &bull; <span style="color:#27ae60;">✅ Vollzählig</span>`;
        }

        let bedienElementeHtml = '';
        if (istVerbrauch) {
            bedienElementeHtml = `
                <div style="display:flex; gap:6px;">
                    <button class="btn" style="background:#27ae60; padding:6px 10px; font-size:0.85em; width:auto; min-height:36px;" onclick="setzeKistenVerbrauchStatus(${z.id}, -2)" title="Ausreichend vorhanden">🟢 Voll/Ausreichend</button>
                    <button class="btn" style="background:#c0392b; padding:6px 10px; font-size:0.85em; width:auto; min-height:36px;" onclick="setzeKistenVerbrauchStatus(${z.id}, -3)" title="Auf Einkaufsliste setzen">🔴 Nachkaufen</button>
                </div>
            `;
        } else {
            const canMinus = ist > 0;
            const canPlus = ist < soll;
            bedienElementeHtml = `
                <button class="btn" style="background:#e74c3c; width:36px; min-width:36px; height:36px; padding:0; font-size:1.1em; ${!canMinus ? 'opacity:0.35; cursor:not-allowed;' : ''}" onclick="aendereArtikelMengeInKiste(${z.id}, -1)" title="${canMinus ? '1 Stück ausbuchen' : 'Bereits 0 vorhanden'}">−</button>
                <input type="text" id="kiste-menge-${z.id}" class="menge-input bestand-menge-input ${ist > 0 ? 'bestand-menge-ok' : 'bestand-menge-low'}" value="${ist}" onchange="speichereKisteMengeInput(${z.id}, this.value)" style="width:60px; height:36px;">
                <button class="btn" style="background:#27ae60; width:36px; min-width:36px; height:36px; padding:0; font-size:1.1em; ${!canPlus ? 'opacity:0.35; cursor:not-allowed;' : ''}" onclick="aendereArtikelMengeInKiste(${z.id}, 1)" title="${canPlus ? '1 Stück einbuchen' : 'Bereits vollzählig'}">+</button>
            `;
        }

        card.innerHTML = `
            <div style="flex:1;">
                <div style="font-weight:bold; font-size:1.02em; color:#2c3e50;">${escapeHtml(z.artikel?.name || 'Unbekannt')}</div>
                <div style="font-size:0.85em; color:#555; margin-top:3px;">${statusText}</div>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
                ${bedienElementeHtml}
                <button class="btn" style="background:#e74c3c; padding:6px 10px; width:auto; min-height:36px; margin-left:6px;" onclick="entferneArtikelAusKiste(${z.id})" title="Aus dieser Kiste entfernen">🗑️</button>
            </div>
        `;
        wrapper.appendChild(card);
    });
}

async function setzeKistenVerbrauchStatus(bestandId, statusWert) {
    await dbClient.from('bestand').update({
        menge: statusWert,
        alte_menge: statusWert,
        created_at: new Date().toISOString()
    }).eq('id', bestandId);

    showToast(statusWert === -3 ? '🔴 Auf Einkaufsliste gesetzt!' : '🟢 Als ausreichend markiert!');
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

// -------------------------------------------------------------------------
// Entnahme mit Personenerfassung (Punkt 3 & 5)
// -------------------------------------------------------------------------
function frageKisteAusbuchen() {
    if (!kistenCheckAktuelleId) return;
    const ort = alleLagerorte.find(o => String(o.id) === String(kistenCheckAktuelleId));
    if (!ort) return;

    ausbuchenPendingAktion = {
        typ: 'kiste',
        kisteId: kistenCheckAktuelleId,
        kisteName: ort.name
    };

    $('entnahme-modal-titel').innerText = `📤 Kiste ausbuchen: ${ort.name}`;
    $('entnahme-modal-sub').innerText = 'Bitte gib an, welcher Resortleiter oder Helfer die Kiste mitnimmt:';

    befuellePersonenSelect();
    openModalById('entnahmePersonModal');
}

function befuellePersonenSelect() {
    const sel = $('entnahme-person-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Person auswählen --</option>';
    alleBenutzerVorlagen.forEach(v => {
        sel.add(new Option(`👤 ${v.name} ${v.kontakt ? `(${v.kontakt})` : ''}`, v.id));
    });
    sel.add(new Option('➕ Anderer Name / Neuer Helfer...', 'custom'));
    $('entnahme-custom-person-wrap').style.display = 'none';
}

function entnahmePersonSelectChanged() {
    const val = $('entnahme-person-select').value;
    $('entnahme-custom-person-wrap').style.display = val === 'custom' ? 'block' : 'none';
}

async function bestaetigeEntnahme() {
    const selVal = $('entnahme-person-select').value;
    let name = '', kontakt = '', vorlageId = null;

    if (!selVal) return showToast('Bitte wähle eine Person aus.', 'warning');

    if (selVal === 'custom') {
        name = $('entnahme-custom-name').value.trim();
        kontakt = $('entnahme-custom-kontakt').value.trim();
        if (!name) return showToast('Bitte Namen eingeben.', 'warning');
        const { data: newV } = await dbClient.from('lager_entnahme_benutzer_vorlagen').insert([{ name, kontakt }]).select();
        if (newV && newV.length) vorlageId = newV[0].id;
    } else {
        const v = alleBenutzerVorlagen.find(b => String(b.id) === String(selVal));
        if (v) { name = v.name; kontakt = v.kontakt || ''; vorlageId = v.id; }
    }

    if (ausbuchenPendingAktion?.typ === 'kiste') {
        const kId = ausbuchenPendingAktion.kisteId;
        const bestand = gibKistenBestand(kId);

        // 1. Zählbare Bestände auf 0 buchen
        const updates = bestand.filter(z => Number(z.ist_menge) >= 0).map(z => {
            return dbClient.from('bestand').update({
                menge: 0,
                alte_menge: z.soll_menge || z.ist_menge,
                created_at: new Date().toISOString()
            }).eq('id', z.id);
        });
        await Promise.all(updates);

        // 2. In lager_entnahmen & Audit eintragen
        const entnahmePayload = {
            name,
            kontakt,
            benutzer_vorlage_id: vorlageId,
            materialien: [{
                kiste_id: Number(kId),
                kiste_name: ausbuchenPendingAktion.kisteName,
                artikel: bestand.map(b => ({
                    bestand_id: b.id,
                    artikel_id: b.artikel_id,
                    name: b.artikel?.name,
                    menge: b.ist_menge > 0 ? b.ist_menge : b.soll_menge,
                    typ: b.artikel?.typ || 'zaehlbar'
                }))
            }],
            created_at: new Date().toISOString()
        };

        await dbClient.from('lager_entnahmen').insert([entnahmePayload]);
        await dbClient.from('lager_entnahme_audit').insert([{
            ...entnahmePayload,
            ereignis: 'entnahme'
        }]).catch(() => {});

        showToast(`📤 "${ausbuchenPendingAktion.kisteName}" an ${name} ausgebucht!`);
    }

    closeModal('entnahmePersonModal');
    ausbuchenPendingAktion = null;
    await ladeAlles();
    if (kistenCheckAktuelleId) oeffneKistenCheck(kistenCheckAktuelleId);
}

// -------------------------------------------------------------------------
// Rückgabe der Kiste
// -------------------------------------------------------------------------
async function ganzeKisteZurueckbuchen() {
    if (!kistenCheckAktuelleId) return;
    const bestand = gibKistenBestand(kistenCheckAktuelleId);

    const updates = bestand.filter(z => Number(z.ist_menge) >= 0).map(z => {
        const soll = z.soll_menge > 0 ? z.soll_menge : (z.alte_menge > 0 ? z.alte_menge : z.ist_menge);
        return dbClient.from('bestand').update({
            menge: soll,
            created_at: new Date().toISOString()
        }).eq('id', z.id);
    });
    await Promise.all(updates);

    // Offene Entnahme für diese Kiste schließen & im Audit protokollieren
    const offene = offeneEntnahmen.filter(e => {
        const mats = Array.isArray(e.materialien) ? e.materialien : [];
        return mats.some(m => String(m.kiste_id) === String(kistenCheckAktuelleId));
    });

    for (const ent of offene) {
        await dbClient.from('lager_entnahme_audit').insert([{
            entnahme_id: ent.id,
            name: ent.name,
            kontakt: ent.kontakt,
            materialien: ent.materialien,
            ereignis: 'rueckgabe',
            created_at: new Date().toISOString()
        }]).catch(() => {});
        await dbClient.from('lager_entnahmen').delete().eq('id', ent.id);
    }

    if (navigator.vibrate) navigator.vibrate(200);
    showToast('✅ Kiste vollständig zurückgebucht & Entnahme abgeschlossen!');
    await ladeAlles();
    oeffneKistenCheck(kistenCheckAktuelleId);
}

async function aendereArtikelMengeInKiste(bestandId, delta) {
    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;
    const aktuell = Number(eintrag.ist_menge);
    if (aktuell < 0) return;

    const soll = Number(eintrag.soll_menge) || 0;

    if (delta > 0 && soll > 0 && aktuell >= soll) {
        showToast(`Bereits vollzählig (${soll} von ${soll} im Lager). Mehr kann nicht eingebucht werden.`, 'warning');
        return;
    }
    if (delta < 0 && aktuell <= 0) {
        showToast(`Bereits 0 vorhanden – kann nicht weiter ausgebucht werden!`, 'warning');
        return;
    }

    const neu = soll > 0 ? Math.min(soll, Math.max(0, aktuell + delta)) : Math.max(0, aktuell + delta);

    await dbClient.from('bestand').update({
        menge: neu,
        created_at: new Date().toISOString()
    }).eq('id', bestandId);

    if (navigator.vibrate) navigator.vibrate(60);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

async function speichereKisteMengeInput(bId, rawVal) {
    const eintrag = aktuelleDaten.find(b => b.id === bId);
    if (!eintrag) return;
    const soll = Number(eintrag.soll_menge) || 0;
    let val = werteMengeAus(rawVal);
    if (soll > 0 && val > soll) {
        showToast(`Maximal ${soll} ${eintrag.artikel?.einheit || 'Stück'} möglich! Höhere Mengen bitte im Hauptfenster eintragen.`, 'warning');
        val = soll;
    }
    if (val < 0) val = 0;

    await dbClient.from('bestand').update({
        menge: val,
        created_at: new Date().toISOString()
    }).eq('id', bId);

    showToast(`Bestand: ${val} / ${soll}`);
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

    const sonstigOrt = alleLagerorte.find(o => 
        o.name.trim().toLowerCase() === 'sonstiger lagerort' || 
        o.name.trim().toLowerCase() === 'sonstiges'
    );

    const sonstigEintrag = sonstigOrt 
        ? aktuelleDaten.find(b => b.artikel_id === art.id && String(b.lagerort_id) === String(sonstigOrt.id))
        : null;

    const kistenEintrag = aktuelleDaten.find(b => 
        b.artikel_id === art.id && String(b.lagerort_id) === String(kistenCheckAktuelleId)
    );

    const aktuellInKiste = kistenEintrag ? Number(kistenEintrag.soll_menge >= 0 ? kistenEintrag.soll_menge : kistenEintrag.menge) : 0;
    const verfuegbarSonstige = sonstigEintrag ? Number(sonstigEintrag.soll_menge >= 0 ? sonstigEintrag.soll_menge : sonstigEintrag.menge) : 0;
    const maxMoeglich = aktuellInKiste + verfuegbarSonstige;

    if (maxMoeglich <= 0) {
        return showToast(`Kein Bestand von "${art.name}" bei "Sonstiger Lagerort" vorhanden (0 verfügbar).`, 'warning');
    }

    const promptText = `Wie viele "${art.name}" sollen in dieser Kiste liegen?\n` +
        `(Maximal ${maxMoeglich} Stück möglich: ${verfuegbarSonstige} bei "Sonstiger Lagerort"${aktuellInKiste > 0 ? ` + ${aktuellInKiste} bereits in dieser Kiste` : ''})`;

    const startMenge = prompt(promptText, String(maxMoeglich));
    if (startMenge === null) return;

    const zielMenge = werteMengeAus(startMenge);
    if (zielMenge <= 0) return showToast('Bitte eine Menge größer als 0 eingeben.', 'warning');
    if (zielMenge > maxMoeglich) return showToast(`Maximal ${maxMoeglich} Stück möglich!`, 'warning');

    const diff = zielMenge - aktuellInKiste;
    const neuerSonstigBestand = verfuegbarSonstige - diff;

    if (kistenEintrag) {
        await dbClient.from('bestand').update({
            menge: zielMenge,
            alte_menge: zielMenge,
            created_at: new Date().toISOString()
        }).eq('id', kistenEintrag.id);
    } else {
        await dbClient.from('bestand').insert([{
            artikel_id: art.id,
            lagerort_id: Number(kistenCheckAktuelleId),
            menge: zielMenge,
            alte_menge: zielMenge,
            created_at: new Date().toISOString()
        }]);
    }

    if (sonstigEintrag) {
        if (neuerSonstigBestand <= 0) {
            await dbClient.from('bestand').delete().eq('id', sonstigEintrag.id);
        } else {
            await dbClient.from('bestand').update({
                menge: neuerSonstigBestand,
                alte_menge: neuerSonstigBestand,
                created_at: new Date().toISOString()
            }).eq('id', sonstigEintrag.id);
        }
    }

    inp.value = '';
    showToast(`✅ Bestände für "${art.name}" aktualisiert.`);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

async function entferneArtikelAusKiste(bestandId) {
    if (!confirm('Diesen Artikel wirklich aus dieser Kiste entfernen und auf "Sonstiger Lagerort" setzen?')) return;

    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;

    let sonstigOrt = alleLagerorte.find(o => 
        o.name.trim().toLowerCase() === 'sonstiger lagerort' || 
        o.name.trim().toLowerCase() === 'sonstiges'
    );

    if (!sonstigOrt) {
        const { data: neuerOrt, error: ortErr } = await dbClient.from('lagerorte').insert([{ name: 'Sonstiger Lagerort' }]).select();
        if (ortErr || !neuerOrt || !neuerOrt.length) return showToast('Fehler beim Anlegen von Sonstiger Lagerort', 'error');
        sonstigOrt = neuerOrt[0];
        await ladeLagerorte();
    }

    const existierenderEintrag = aktuelleDaten.find(b => 
        b.artikel_id === eintrag.artikel_id && 
        String(b.lagerort_id) === String(sonstigOrt.id) && 
        b.id !== bestandId
    );

    if (existierenderEintrag) {
        let neueMenge;
        if (Number(existierenderEintrag.menge) < 0 || Number(eintrag.menge) < 0) {
            neueMenge = existierenderEintrag.menge;
        } else {
            neueMenge = Number(existierenderEintrag.menge) + Number(eintrag.menge);
        }

        await dbClient.from('bestand').update({
            menge: neueMenge,
            alte_menge: neueMenge,
            created_at: new Date().toISOString()
        }).eq('id', existierenderEintrag.id);

        await dbClient.from('bestand').delete().eq('id', bestandId);
    } else {
        await dbClient.from('bestand').update({
            lagerort_id: sonstigOrt.id,
            created_at: new Date().toISOString()
        }).eq('id', bestandId);
    }

    showToast(`Artikel auf "${sonstigOrt.name}" verschoben.`);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

function schliesseKistenCheckModal() {
    closeModal('kistenCheckModal');
    kistenCheckAktuelleId = '';
}

// =========================================================================
// 6. SCAN- & RÜCKGABE-HUB (EINFACH FÜR HELFER)
// =========================================================================

function oeffneScanHubModal(vorbelegterSuchbegriff = '') {
    $('artikel-finder-input').value = vorbelegterSuchbegriff;
    finderFilterModus = vorbelegterSuchbegriff ? 'alle' : 'fehlend';
    aktualisiereFinderFilterButtons();
    aktualisiereArtikelFinderListe(vorbelegterSuchbegriff);
    
    stoppeHubKamera();
    openModalById('scanHubModal');
}

function schliesseScanHubModal() {
    stoppeHubKamera();
    closeModal('scanHubModal');
}

async function toggleHubKamera() {
    if (hubKameraAktiv) stoppeHubKamera();
    else await starteHubKamera();
}

async function starteHubKamera() {
    const wrap = $('hub-camera-wrapper');
    const status = $('hub-scanner-status');
    const btnText = $('hub-kamera-text');
    
    wrap.style.display = 'block';
    status.style.display = 'block';
    status.innerText = 'Kamera startet…';
    if (btnText) btnText.innerText = '✕ Kamera stoppen';
    hubKameraAktiv = true;

    if (aktiverQrScanner) {
        try { await aktiverQrScanner.stop(); aktiverQrScanner.clear(); } catch {}
    }

    aktiverQrScanner = new Html5Qrcode('hub-qr-reader');
    try {
        await aktiverQrScanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            (decoded) => {
                status.innerText = 'Erkannt: ' + decoded;
                stoppeHubKamera();
                schliesseScanHubModal();
                verarbeiteUniversalScan(decoded);
            },
            () => {}
        );
        status.innerText = 'Bereit – QR-Code vor die Kamera halten.';
    } catch (err) {
        showToast('Kamera konnte nicht gestartet werden: ' + err.message, 'error');
        stoppeHubKamera();
    }
}

function stoppeHubKamera() {
    if (aktiverQrScanner) {
        aktiverQrScanner.stop().then(() => aktiverQrScanner.clear()).catch(() => {}).finally(() => { aktiverQrScanner = null; });
    }
    const wrap = $('hub-camera-wrapper');
    const status = $('hub-scanner-status');
    const btnText = $('hub-kamera-text');
    if (wrap) wrap.style.display = 'none';
    if (status) status.style.display = 'none';
    if (btnText) btnText.innerText = 'Kamera-Scan';
    hubKameraAktiv = false;
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
        const ist = Number(b.ist_menge);
        const fehlt = (soll > 0 && ist >= 0 && ist < soll);

        if (term) {
            const matches = [b.artikel?.name, b.lagerorte?.name, b.artikel?.kategorie]
                .some(field => (field || '').toLowerCase().includes(term));
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
        const ist = Number(z.ist_menge);
        const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
        const einheit = z.artikel?.einheit || 'Stück';

        let standText = '';
        if (ist === -1) standText = '∞ Unbegrenzt';
        else if (ist === -2 || ist === -3) standText = ist === -3 ? '🔴 Nachkaufen' : '<span class="bestand-status-pill ok">-</span> Ausreichend';
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
                    ${ist >= 0 ? `
                    <button class="btn" style="background:#27ae60; padding:8px 12px; width:auto; min-height:40px;" onclick="buchtArtikelZurueckInKiste(${z.id})">
                        📥 Hier rein (+1)
                    </button>
                    ` : `
                    <span style="display:inline-flex; align-items:center; padding:0 8px; color:#27ae60; font-weight:bold;">${ist === -3 ? '🔴 Nachkauf' : '✅ Vorhanden'}</span>
                    `}
                    <button class="btn" style="background:#3498db; padding:8px 10px; width:auto; min-height:40px;" onclick="schliesseScanHubModal(); oeffneKistenCheck(${z.lagerort_id})" title="Kiste öffnen">📦</button>
                </div>
            </div>
        `;
    }).join('');
}

async function buchtArtikelZurueckInKiste(bestandId) {
    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;

    const aktuell = Number(eintrag.ist_menge);
    const soll = Number(eintrag.soll_menge) || 0;

    if (soll > 0 && aktuell >= soll) {
        showToast(`⚠️ "${eintrag.artikel?.name}" ist in "${eintrag.lagerorte?.name}" bereits vollzählig (${soll}/${soll})!`, 'warning');
        return;
    }

    const neu = aktuell < 0 ? aktuell : (soll > 0 ? Math.min(soll, aktuell + 1) : aktuell + 1);

    await dbClient.from('bestand').update({
        menge: neu,
        created_at: new Date().toISOString()
    }).eq('id', bestandId);

    if (navigator.vibrate) navigator.vibrate(120);
    showToast(`✅ 1x "${eintrag.artikel?.name}" in "${eintrag.lagerorte?.name}" zurückgebucht (${neu}/${soll})!`);
    await ladeAlles();
    aktualisiereArtikelFinderListe($('artikel-finder-input').value);
}

// =========================================================================
// 7. HARDWARE SCANNING (NFC & UNIVERSAL-SCAN)
// =========================================================================

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
        schliesseScanHubModal();
        oeffneKistenCheck(ort.id);
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
    const btn = $('hub-nfc-btn');
    const text = $('hub-nfc-text');
    if (btn) {
        btn.classList.toggle('nfc-aktiv', aktiv);
        if (text) text.innerText = aktiv ? 'NFC aktiv (Stopp)' : 'NFC-Scan';
    }
}

async function holeOderErzeugeOrtCode(ort) {
    if (!ort) return null;
    if (ort.nfc_code) return ort.nfc_code;
    const slug = String(ort.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    const code = `kiste-${slug}-${ort.id}`;
    await dbClient.from('lagerorte').update({ nfc_code: code }).eq('id', ort.id);
    ort.nfc_code = code;
    return code;
}

async function schreibeNfcTagFuerOrt() {
    const oId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(oId));
    if (!ort) return showToast('Bitte zuerst Lagerort auswählen.', 'warning');

    const code = await holeOderErzeugeOrtCode(ort);
    ortSelectChanged();

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
// 8. LAGER-MODUS (TABELLE & SORTIERUNG)
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

    const resMap = {};
    packlistenPositionen.forEach(p => {
        if (!p.artikel_id) return;
        if (!resMap[p.artikel_id]) resMap[p.artikel_id] = { gesamt: 0, listen: {} };
        resMap[p.artikel_id].gesamt += Number(p.menge);
        const pl = packlisten.find(l => String(l.id) === String(p.packliste_id));
        const plName = pl ? pl.name : 'Unbekannt';
        resMap[p.artikel_id].listen[plName] = (resMap[p.artikel_id].listen[plName] || 0) + Number(p.menge);
    });

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
            else if (Number(z.menge) >= 0) ordnerSumme += Number(z.soll_menge >= 0 ? z.soll_menge : z.menge);
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

        const artMap = new Map();
        zeilen.forEach(z => {
            if (!artMap.has(z.artikel_id)) artMap.set(z.artikel_id, { artikel: z.artikel, bestaende: [] });
            artMap.get(z.artikel_id).bestaende.push(z);
        });

        const prefixArtikelSets = {};
        const prefixSums = {};
        const prefixInf = {};

        artMap.forEach(grp => {
            const parts = grp.artikel.name.trim().split(' ');
            if (parts.length > 1) {
                const pref = parts[0];
                if (!prefixArtikelSets[pref]) prefixArtikelSets[pref] = new Set();
                prefixArtikelSets[pref].add(grp.artikel.id);

                grp.bestaende.forEach(b => {
                    if (Number(b.menge) === -1) prefixInf[pref] = true;
                    else if (Number(b.menge) >= 0) prefixSums[pref] = (prefixSums[pref] || 0) + Number(b.soll_menge >= 0 ? b.soll_menge : b.menge);
                });
            }
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

            const hatMehrereVerschiedeneArtikel = parts.length > 1 && prefixArtikelSets[parts[0]] && prefixArtikelSets[parts[0]].size > 1;
            const pref = hatMehrereVerschiedeneArtikel ? parts[0] : null;

            if (hatMehrereVerschiedeneArtikel && currentPrefix !== pref) {
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
            } else if (!hatMehrereVerschiedeneArtikel) {
                currentPrefix = null;
            }

            const tr = document.createElement('tr');
            tr.style.cursor = isEditMode ? 'pointer' : 'default';
            tr.onclick = (e) => {
                if (!['INPUT', 'BUTTON', 'SVG', 'PATH'].includes(e.target.tagName)) openEditModal(artId);
            };

            const displayName = hatMehrereVerschiedeneArtikel ? grp.artikel.name.trim().substring(pref.length).trim() : grp.artikel.name;
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
                const soll = Number(b.soll_menge);
                const ist = Number(b.ist_menge);
                const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
                
                let zelle = '';
                if (m === -1) {
                    zelle = `<span style="font-size:1.2em; color:#7f8c8d; font-weight:bold;">∞</span> <small class="bestand-einheit">${einheit}</small>`;
                } else if (m === -2 || m === -3) {
                    zelle = `<span class="bestand-status-pill ${m === -3 ? 'warn' : 'ok'}">-</span>`;
                } else {
                    zelle = `
                        <div style="display:flex; flex-direction:column; align-items:flex-end;">
                            <div class="bestand-ort-qty-wrap">
                                <input type="text" id="menge-${b.id}" class="menge-input bestand-menge-input ${soll > 0 ? 'bestand-menge-ok' : 'bestand-menge-low'}" value="${soll}" onchange="speichereMenge(${b.id})" oninput="aktualisiereMengeEingabeFarbe(this)" style="width:60px;" title="Gesamtbestand im Verein">
                                <small class="bestand-einheit">${einheit}</small>
                            </div>
                            ${fehlt > 0 ? `<div style="font-size:0.8em; color:#c0392b; font-weight:bold; margin-top:2px;">⚠️ ${fehlt} unterwegs (${ist} im Lager)</div>` : ''}
                        </div>`;
                }
                return `<div class="bestand-ort-row"><span class="bestand-ort-name">📍 ${escapeHtml(b.lagerorte?.name || '')}</span>${zelle}</div>`;
            }).join('');

            let latestDate = null;
            grp.bestaende.forEach(b => { if (b.created_at && (!latestDate || new Date(b.created_at) > latestDate)) latestDate = new Date(b.created_at); });
            const dateStr = latestDate ? latestDate.toLocaleDateString('de-DE') + ' ' + latestDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : 'Unbekannt';

            tr.innerHTML = `
                <td style="padding-left:${hatMehrereVerschiedeneArtikel ? 45 : 25}px;" data-hover-type="date" data-hover-content="${dateStr}" onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)">
                    ${hatMehrereVerschiedeneArtikel ? '◦' : '↳'} <strong>${escapeHtml(displayName)}</strong>${wichtigBadge}${kommentarIcon}${kommentarAnzeige}
                    <div style="font-size:0.7em; color:#b0b0b0; margin-top:2px;">ID: ${formatArtikelId(grp.artikel.id)}</div>
                </td>
                <td colspan="2">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        ${bestandRowsHtml}
                        ${resHtml ? `<div style="display:flex; justify-content:flex-end; margin-top:2px;">${resHtml}</div>` : ''}
                    </div>
                </td>`;
            tbody.appendChild(tr);
        });
    });

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
    const eintrag = aktuelleDaten.find(b => b.id === bId);
    const altesSoll = Number(eintrag?.soll_menge) || 0;
    const altesIst = Number(eintrag?.ist_menge) || 0;

    let neuesIst = neueMenge;
    if (neueMenge >= 0) {
        const diff = neueMenge - altesSoll;
        neuesIst = Math.max(0, Math.min(neueMenge, (altesIst >= 0 ? altesIst : neueMenge) + diff));
    }

    let { error } = await dbClient.from('bestand').update({
        menge: neueMenge < 0 ? neueMenge : neuesIst,
        alte_menge: neueMenge,
        created_at: datum
    }).eq('id', bId);

    if (!error) {
        f.style.backgroundColor = '#d4edda';
        showToast(`Gesamtbestand gespeichert: ${f.value}`);
        setTimeout(() => { if (f) f.style.backgroundColor = ''; ladeAlles(); }, 800);
    } else showToast('Speicherfehler!', 'error');
}

window.handleMouseEnter = (e) => {
    const t = e.currentTarget;
    if (t.dataset.hoverType === 'date') { $('hover-date-text').innerHTML = t.dataset.hoverContent; $('hover-date-info').style.display = 'block'; }
    if (t.dataset.hoverType === 'res') { $('hover-res-text').innerHTML = t.dataset.hoverContent; $('hover-res-info').style.display = 'block'; }
};
window.handleMouseLeave = () => { $('hover-date-info').style.display = 'none'; $('hover-res-info').style.display = 'none'; };

// =========================================================================
// 9. KISTEN-ANSICHT, OFFENE ENTNAHMEN & QR-DRUCK
// =========================================================================

function setzeKistenAnsichtFilter(filterName) {
    kistenAnsichtFilter = filterName;
    ['alle', 'ausgeliehen', 'entnahmen'].forEach(f => {
        const btn = $(`filter-kisten-${f}`);
        if (btn) btn.classList.toggle('active', f === filterName);
    });

    const kistenTabelle = $('kisten-tabelle-bereich');
    const entnahmenBereich = $('entnahmen-liste-bereich');

    if (filterName === 'entnahmen') {
        if (kistenTabelle) kistenTabelle.style.display = 'none';
        if (entnahmenBereich) {
            entnahmenBereich.style.display = 'block';
            renderOffeneEntnahmenListe();
        }
    } else {
        if (kistenTabelle) kistenTabelle.style.display = 'block';
        if (entnahmenBereich) entnahmenBereich.style.display = 'none';
        renderKistenListe();
    }
}

function renderKistenListe() {
    const ziel = $('kisten-tabelle');
    if (!ziel) return;

    const suchText = ($('kisten-such-filter')?.value || '').toLowerCase().trim();

    let liste = alleLagerorte.filter(o => {
        if (suchText && !o.name.toLowerCase().includes(suchText) && !(o.nfc_code || '').toLowerCase().includes(suchText)) {
            return false;
        }
        if (kistenAnsichtFilter === 'ausgeliehen') {
            const bestand = gibKistenBestand(o.id);
            const entnahme = ermittleKistenEntnahmeStatus(o.id);
            const fehlt = bestand.some(b => Number(b.soll_menge) > 0 && Number(b.ist_menge) < Number(b.soll_menge));
            return Boolean(entnahme || fehlt);
        }
        return true;
    });

    if (!liste.length) {
        ziel.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Keine passenden Kisten gefunden.</td></tr>';
        return;
    }

    ziel.innerHTML = liste.map(o => {
        const bestand = gibKistenBestand(o.id);
        const fehlt = bestand.some(b => Number(b.soll_menge) > 0 && Number(b.ist_menge) < Number(b.soll_menge));
        const entnahme = ermittleKistenEntnahmeStatus(o.id);

        let statusCell = '';
        if (entnahme) {
            statusCell = `<span style="color:#d35400; font-weight:bold;">📤 Bei ${escapeHtml(entnahme.name)}</span>`;
        } else if (fehlt) {
            statusCell = `<span style="color:#c0392b; font-weight:bold;">🔴 Teile fehlen</span>`;
        } else {
            statusCell = `<span style="color:#27ae60; font-weight:bold;">✔️ Vollzählig</span>`;
        }

        return `
            <tr>
                <td><strong>${escapeHtml(o.name)}</strong><br><small style="color:#7f8c8d;">${escapeHtml(o.nfc_code || 'Kein Code')}</small></td>
                <td>${bestand.length} Artikel</td>
                <td>${statusCell}</td>
                <td>
                    <button class="btn" style="background:#16a085; padding:8px 12px; width:auto;" onclick="oeffneKistenCheck(${o.id})">📦 Inhalt / Prüfen</button>
                    <button class="btn" style="background:#3498db; padding:8px 12px; width:auto;" onclick="openOrteVerwalten(${o.id})">⚙️</button>
                </td>
            </tr>`;
    }).join('');
}

function renderOffeneEntnahmenListe() {
    const ziel = $('entnahmen-liste-bereich');
    if (!ziel) return;

    if (!offeneEntnahmen.length) {
        ziel.innerHTML = `
            <div style="background:#edf8f0; border:1px solid #8fd0a3; padding:25px; border-radius:10px; text-align:center;">
                <h3 style="color:#1f7a37; margin:0 0 6px 0;">🎉 Alles im Lager vorhanden!</h3>
                <p style="margin:0; color:#555;">Es sind aktuell keine offenen Entnahmen vermerkt.</p>
            </div>
        `;
        return;
    }

    ziel.innerHTML = offeneEntnahmen.map(ent => {
        const datum = new Date(ent.created_at).toLocaleString('de-DE');
        const mats = Array.isArray(ent.materialien) ? ent.materialien : [];

        const itemsHtml = mats.map(m => {
            if (m.kiste_name) {
                return `<li><strong>📦 ${escapeHtml(m.kiste_name)}</strong> (Kiste komplett entnommen)</li>`;
            }
            return `<li><strong>${m.menge || 1}x</strong> ${escapeHtml(m.name || m.label || 'Material')}</li>`;
        }).join('');

        return `
            <div class="entnahme-card">
                <div class="entnahme-card-header">
                    <div>
                        <strong style="font-size:1.15em; color:#2c3e50;">👤 ${escapeHtml(ent.name)}</strong>
                        <div style="font-size:0.85em; color:#7f8c8d; margin-top:2px;">
                            📅 Entnommen am: ${datum} ${ent.kontakt ? `&bull; 📞 ${escapeHtml(ent.kontakt)}` : ''}
                        </div>
                    </div>
                    <button class="btn" style="background:#27ae60; padding:6px 12px; font-size:0.85em; width:auto;" onclick="schliesseEntnahmeKomplett('${ent.id}')">
                        ✅ Vollständig zurückgebucht
                    </button>
                </div>
                <div style="font-size:0.9em; color:#444;">
                    <ul style="margin:6px 0; padding-left:20px;">
                        ${itemsHtml}
                    </ul>
                </div>
            </div>
        `;
    }).join('');
}

async function schliesseEntnahmeKomplett(entnahmeId) {
    if (!confirm('Soll diese Entnahme als vollständig zurückgebracht verbucht und abgeschlossen werden?')) return;

    const ent = offeneEntnahmen.find(e => String(e.id) === String(entnahmeId));
    if (!ent) return;

    // Kisten-Inhalte wieder vollsetzen falls Kiste geliehen war
    const mats = Array.isArray(ent.materialien) ? ent.materialien : [];
    for (const m of mats) {
        if (m.kiste_id) {
            const bestand = gibKistenBestand(m.kiste_id);
            const updates = bestand.filter(z => Number(z.ist_menge) >= 0).map(z => {
                const soll = z.soll_menge > 0 ? z.soll_menge : (z.alte_menge > 0 ? z.alte_menge : z.ist_menge);
                return dbClient.from('bestand').update({ menge: soll, created_at: new Date().toISOString() }).eq('id', z.id);
            });
            await Promise.all(updates);
        }
    }

    await dbClient.from('lager_entnahme_audit').insert([{
        entnahme_id: ent.id,
        name: ent.name,
        kontakt: ent.kontakt,
        materialien: ent.materialien,
        ereignis: 'rueckgabe',
        created_at: new Date().toISOString()
    }]).catch(() => {});

    await dbClient.from('lager_entnahmen').delete().eq('id', ent.id);
    showToast(`✅ Entnahme von ${ent.name} abgeschlossen!`);
    await ladeAlles();
    renderOffeneEntnahmenListe();
}

function openNeuOrtModal() { $('neu-ort-name').value = ''; openModalById('neuOrtModal'); }
async function speichereNeuenOrt() {
    const name = $('neu-ort-name').value.trim();
    if (!name) return;
    await dbClient.from('lagerorte').insert([{ name }]);
    closeModal('neuOrtModal');
    showToast('Lagerort angelegt!');
    await ladeAlles();
    if ($('manage-ort-select')) {
        populateSelect($('manage-ort-select'), alleLagerorte);
        ortSelectChanged();
    }
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
    const statusEl = $('manage-ort-code-status'), delBtn = $('manage-ort-nfc-entfernen-btn');
    if (statusEl) statusEl.textContent = ort?.nfc_code ? `Aktueller Code: ${ort.nfc_code}` : 'Noch kein Code hinterlegt (wird beim ersten NFC-Schreiben oder QR-Erstellen automatisch generiert).';
    if (delBtn) delBtn.style.display = ort?.nfc_code ? 'block' : 'none';

    const qrBox = $('manage-ort-qr-box');
    if (qrBox) qrBox.style.display = 'none';
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
    showToast('Code-Zuordnung entfernt.');
    await ladeAlles();
    ortSelectChanged();
}

async function zeigeEinzelKisteQr() {
    const selId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(selId));
    if (!ort) return showToast('Bitte zuerst Lagerort auswählen.', 'warning');

    const code = await holeOderErzeugeOrtCode(ort);
    ortSelectChanged();

    const qrBox = $('manage-ort-qr-box');
    const preview = $('manage-ort-qr-preview');
    if (!qrBox || !preview) return;

    preview.innerHTML = '';
    const url = `https://trilager.pius-s.de?kistencheck=${encodeURIComponent(code)}`;
    new QRCode(preview, { text: url, width: 140, height: 140 });
    qrBox.style.display = 'block';
}

function downloadEinzelKistenQr() {
    const selId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(selId));
    const canvas = $('manage-ort-qr-preview')?.querySelector('canvas');
    if (!canvas || !ort) return;

    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `QR_${ort.name.replace(/[^a-z0-9]/gi, '_')}.png`;
    a.click();
}

function druckeEinzelKistenQr() {
    const selId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(selId));
    if (ort) druckeKistenEtiketten([ort]);
}

function openKistenEtikettenModal() {
    kistenEtikettenAuswahlIds.clear();
    const allChk = $('kisten-etiketten-alle');
    if (allChk) allChk.checked = false;
    const sInp = $('kisten-etiketten-suche');
    if (sInp) sInp.value = '';
    renderKistenEtikettenListe();
    openModalById('kistenEtikettenModal');
}

function renderKistenEtikettenListe() {
    const ziel = $('kisten-etiketten-liste');
    if (!ziel) return;
    const filter = ($('kisten-etiketten-suche')?.value || '').toLowerCase().trim();
    const liste = alleLagerorte.filter(o => !filter || o.name.toLowerCase().includes(filter) || (o.nfc_code || '').toLowerCase().includes(filter));

    if (!liste.length) {
        ziel.innerHTML = '<p style="text-align:center; color:#7f8c8d; padding:15px;">Keine Kisten gefunden.</p>';
        return;
    }

    ziel.innerHTML = liste.map(ort => {
        const isChk = kistenEtikettenAuswahlIds.has(String(ort.id));
        return `
            <label class="kiste-etikett-zeile" style="cursor:pointer;">
                <input type="checkbox" style="width:18px; height:18px;" ${isChk ? 'checked' : ''} onchange="toggleKistenEtikettAuswahl('${ort.id}', this.checked)">
                <div style="flex:1;">
                    <strong>📦 ${escapeHtml(ort.name)}</strong>
                    <div style="font-size:0.8em; color:#7f8c8d;">${escapeHtml(ort.nfc_code || 'Code wird beim Druck automatisch vergeben')}</div>
                </div>
            </label>
        `;
    }).join('');

    $('kisten-etiketten-count').textContent = kistenEtikettenAuswahlIds.size;
    $('kisten-etiketten-drucken-btn').disabled = !kistenEtikettenAuswahlIds.size;
}

function toggleKistenEtikettAuswahl(id, chk) {
    if (chk) kistenEtikettenAuswahlIds.add(String(id));
    else kistenEtikettenAuswahlIds.delete(String(id));
    $('kisten-etiketten-count').textContent = kistenEtikettenAuswahlIds.size;
    $('kisten-etiketten-drucken-btn').disabled = !kistenEtikettenAuswahlIds.size;
}

function toggleAlleKistenEtiketten(chk) {
    kistenEtikettenAuswahlIds.clear();
    if (chk) alleLagerorte.forEach(o => kistenEtikettenAuswahlIds.add(String(o.id)));
    renderKistenEtikettenListe();
}

async function druckeAusgewaehlteKistenEtiketten() {
    const ausgewaehlt = alleLagerorte.filter(o => kistenEtikettenAuswahlIds.has(String(o.id)));
    if (!ausgewaehlt.length) return;

    for (const ort of ausgewaehlt) {
        await holeOderErzeugeOrtCode(ort);
    }
    await ladeLagerorte();
    druckeKistenEtiketten(ausgewaehlt);
}

function druckeKistenEtiketten(liste) {
    const win = window.open('', '_blank');
    const itemsHtml = liste.map(o => {
        const code = o.nfc_code || `kiste-${o.id}`;
        const link = `https://trilager.pius-s.de?kistencheck=${encodeURIComponent(code)}`;
        return `
            <div class="kiste-label-card">
                <div class="kiste-label-qr" data-link="${link}"></div>
                <div class="kiste-label-info">
                    <div class="kiste-label-title">${escapeHtml(o.name)}</div>
                    <div class="kiste-label-sub">📦 TRISPORT LAGER</div>
                    <div class="kiste-label-code">${escapeHtml(code)}</div>
                </div>
            </div>
        `;
    }).join('');

    win.document.write(`
        <html><head><title>Kisten-Etiketten drucken</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
        <style>
            @page { size: A4 portrait; margin: 8mm 5mm; }
            body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: #fff; }
            .labels-grid { display: grid; grid-template-columns: repeat(3, 70mm); grid-auto-rows: 37mm; gap: 0; justify-content: center; }
            .kiste-label-card { width: 70mm; height: 37mm; box-sizing: border-box; padding: 2.5mm 3.5mm; display: flex; align-items: center; gap: 3mm; border: 1px dashed #e2e8f0; page-break-inside: avoid; overflow: hidden; }
            .kiste-label-qr { width: 29mm; height: 29mm; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
            .kiste-label-qr canvas, .kiste-label-qr img { width: 29mm !important; height: 29mm !important; }
            .kiste-label-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
            .kiste-label-title { font-size: 11.5px; font-weight: bold; color: #111; line-height: 1.25; word-break: break-word; max-height: 21mm; overflow: hidden; }
            .kiste-label-sub { font-size: 7.5px; font-weight: bold; color: #e3000f; margin-top: 3px; letter-spacing: 0.4px; }
            .kiste-label-code { font-size: 7px; color: #666; font-family: monospace; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .no-p { position: fixed; top: 10px; right: 10px; padding: 10px 18px; background: #e3000f; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.2); }
            @media print { .no-p { display: none; } .kiste-label-card { border: 1px dashed transparent; } }
        </style>
        </head><body>
            <button class="no-p" onclick="window.print()">🖨️ Etiketten drucken</button>
            <div class="labels-grid">${itemsHtml}</div>
            <script>
                window.onload = function() {
                    document.querySelectorAll('.kiste-label-qr').forEach(el => {
                        new QRCode(el, { text: el.dataset.link, width: 140, height: 140 });
                    });
                };
            <\/script>
        </body></html>`);
    win.document.close();
}

// =========================================================================
// 10. ARTIKEL ANLEGEN & BEARBEITEN
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

    let artId = null;
    let existierenderArtikel = alleArtikelInfos.find(a => a.name.trim().toLowerCase() === name.toLowerCase());

    if (!existierenderArtikel) {
        const { data: dbCheck } = await dbClient.from('artikel').select('*').ilike('name', name);
        if (dbCheck && dbCheck.length > 0) existierenderArtikel = dbCheck[0];
    }

    if (existierenderArtikel) {
        artId = existierenderArtikel.id;
        const { error: updateErr } = await dbClient.from('artikel').update({
            name,
            kategorie: kat,
            einheit,
            wichtig,
            typ
        }).eq('id', artId);
        if (updateErr) return showToast('Fehler beim Aktualisieren: ' + updateErr.message, 'error');
        await dbClient.from('bestand').delete().eq('artikel_id', artId);
    } else {
        const { data, error } = await dbClient.from('artikel').insert([{ name, kategorie: kat, einheit, wichtig, typ }]).select();
        if (error) return showToast('Fehler: ' + error.message, 'error');
        artId = data[0].id;
    }

    const inserts = Array.from(document.querySelectorAll('#new-orte-wrapper .lagerort-row')).map(row => {
        const menge = leseBestandswertAusZeile(row);
        const oldVal = werteMengeAus(row.querySelector('.new-menge')?.getAttribute('data-old-value') || '0');
        const soll = menge < 0 ? oldVal : menge;
        return {
            artikel_id: artId,
            lagerort_id: row.querySelector('.new-ort').value,
            menge: menge < 0 ? menge : soll,
            alte_menge: soll
        };
    });

    if (inserts.length) await dbClient.from('bestand').insert(inserts);
    closeModal('artikelModal');
    showToast(existierenderArtikel ? 'Artikel reaktiviert und gespeichert!' : 'Artikel gespeichert!');
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
        const m = Number(data.menge);
        if (m === -1) { displayVal = '∞'; status = 'inf'; }
        else if (m === -2) { displayVal = '-'; status = 'strich-ok'; }
        else if (m === -3) { displayVal = '-'; status = 'strich-warn'; }
        else {
            displayVal = (data.soll_menge !== undefined && data.soll_menge >= 0) ? data.soll_menge : (data.alte_menge ?? m);
        }
    }

    div.innerHTML = `
        <div class="bestand-row-stack" style="width:100%;">
            <select class="edit-ort-select" style="width:100%; padding:10px; border-radius:6px; border:1px solid #ccc;">${options}</select>
            <div class="bestand-action-row" style="flex-wrap:nowrap; width:100%;">
                <input type="text" class="edit-menge-input bestand-menge-input bestand-form-quantity" value="${displayVal}" data-old-value="${data?.alte_menge ?? 0}" oninput="bestandEingabeGeaendert(this)" style="flex:1.25; min-width:0; padding:12px; border-radius:6px; border:1px solid #ccc; text-align:center;" title="Gesamtbestand im Verein">
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

    const alteBestaende = aktuelleDaten.filter(b => String(b.artikel_id) === String(aid));
    await dbClient.from('bestand').delete().eq('artikel_id', aid);

    const inserts = Array.from(document.querySelectorAll('#edit-orte-wrapper .edit-ort-row')).map(row => {
        const oid = row.querySelector('.edit-ort-select').value;
        const neuesSoll = leseBestandswertAusZeile(row);
        const oldVal = werteMengeAus(row.querySelector('.edit-menge-input')?.getAttribute('data-old-value') || '0');
        const soll = neuesSoll < 0 ? oldVal : neuesSoll;

        const vorher = alteBestaende.find(b => String(b.lagerort_id) === String(oid));
        let neuesIst = soll;
        if (vorher && vorher.soll_menge > 0 && soll > 0) {
            const diff = soll - vorher.soll_menge;
            neuesIst = Math.max(0, Math.min(soll, (vorher.ist_menge >= 0 ? vorher.ist_menge : soll) + diff));
        }

        return {
            artikel_id: Number(aid),
            lagerort_id: Number(oid),
            menge: neuesSoll < 0 ? neuesSoll : neuesIst,
            alte_menge: soll
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
// 11. EVENT-MODUS & PACKLISTEN (PUNKT 1 & 2)
// =========================================================================
function wechsleModus(modus) {
    aktuellerModus = modus;
    ['lager', 'kisten', 'event'].forEach(m => {
        const v = $(`ansicht-${m}`), t = $(`tab-${m}`);
        if (v) v.style.display = m === modus ? 'block' : 'none';
        if (t) t.className = m === modus ? 'btn btn-modus active' : 'btn btn-modus';
    });
    if (modus === 'kisten') setzeKistenAnsichtFilter(kistenAnsichtFilter);
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
            verfuegbar = bestandArtikel.reduce((sum, b) => sum + (Number(b.ist_menge) >= 0 ? Number(b.ist_menge) : 0), 0);
            if (verfuegbar < pos.menge) status = `<span class="event-warning">❌ Zu wenig (${verfuegbar - pos.menge})</span>`;
        }

        const mengeZelle = isEventEditMode 
            ? `<input type="text" class="menge-input" value="${pos.menge}" onchange="speicherePackMengeDirekt(${pos.id}, this.value)" style="width:65px; height:34px; padding:4px;">` 
            : `<strong>${pos.menge}</strong>`;

        let actionCell = isEventEditMode ? `
            <button class="btn" style="background:#3498db; padding:4px 8px; font-size:0.8em; margin-left:8px;" onclick="openPackItemModal(${pos.id})" title="Position bearbeiten">✏️</button>
            <button class="btn" style="background:#e74c3c; padding:4px 8px; font-size:0.8em; margin-left:4px;" onclick="loeschePackPosition(${pos.id})" title="Löschen">🗑️</button>
        ` : '';

        tbody.innerHTML += `
            <tr>
                <td><strong>${escapeHtml(name)}</strong></td>
                <td>${mengeZelle}</td>
                <td>${verfuegbar}</td>
                <td>${status} ${actionCell}</td>
            </tr>`;
    });
}

async function speicherePackMengeDirekt(posId, rawVal) {
    const neueMenge = werteMengeAus(rawVal) || 1;
    const { error } = await dbClient.from('packlisten_positionen').update({ menge: neueMenge }).eq('id', posId);
    if (error) {
        showToast('Fehler beim Speichern: ' + error.message, 'error');
    } else {
        showToast(`Menge auf ${neueMenge} geändert!`);
        await ladePacklistenDaten();
        zeigePackliste();
    }
}

function toggleEventEditMode() {
    isEventEditMode = !isEventEditMode;
    $('btn-event-edit').innerText = isEventEditMode ? '✏️ Bearbeiten: AN' : '✏️ Bearbeiten: AUS';
    $('btn-event-edit').style.backgroundColor = isEventEditMode ? '#e67e22' : '#f39c12';
    document.querySelectorAll('.event-edit-only').forEach(el => el.style.display = isEventEditMode ? '' : 'none');
    zeigePackliste();
}

function openPackItemModal(posId = null) {
    if (!$('packlisten-auswahl')?.value) return showToast('Bitte wähle zuerst eine Packliste aus.', 'warning');

    const idInp = $('pack-pos-id');
    const titleEl = $('pack-modal-title');
    const btnEl = $('pack-modal-save-btn');

    if (posId) {
        const pos = packlistenPositionen.find(p => p.id === posId);
        if (!pos) return;
        if (idInp) idInp.value = pos.id;
        if (titleEl) titleEl.innerText = 'Position bearbeiten';
        if (btnEl) btnEl.innerText = 'Speichern';

        if (pos.artikel_id) {
            $('pack-typ').value = 'lager';
            $('pack-artikel-input').value = pos.artikel?.name || '';
            $('pack-eigener-name').value = '';
        } else {
            $('pack-typ').value = 'custom';
            $('pack-eigener-name').value = pos.eigener_name || '';
            $('pack-artikel-input').value = '';
        }
        $('pack-menge').value = pos.menge;
    } else {
        if (idInp) idInp.value = '';
        if (titleEl) titleEl.innerText = 'Packliste ergänzen';
        if (btnEl) btnEl.innerText = 'Hinzufügen';
        $('pack-typ').value = 'lager';
        $('pack-artikel-input').value = '';
        $('pack-eigener-name').value = '';
        $('pack-menge').value = '1';
    }

    togglePackTyp();
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
    const editId = $('pack-pos-id')?.value;

    let artikelId = null;
    let eigenerName = null;

    if (typ === 'lager') {
        const artName = $('pack-artikel-input').value.trim();
        const art = alleArtikelInfos.find(a => a.name.toLowerCase() === artName.toLowerCase());
        if (!art) return showToast('Artikel nicht im Lager gefunden.', 'warning');
        artikelId = art.id;
    } else {
        const cName = $('pack-eigener-name').value.trim();
        if (!cName) return showToast('Bitte Namen eingeben.', 'warning');
        eigenerName = cName;
    }

    const payload = {
        packliste_id: Number(plId),
        menge,
        artikel_id: artikelId,
        eigener_name: eigenerName
    };

    if (editId) {
        const { error } = await dbClient.from('packlisten_positionen').update(payload).eq('id', editId);
        if (error) return showToast('Fehler beim Aktualisieren: ' + error.message, 'error');
        showToast('Position aktualisiert!');
    } else {
        const { error } = await dbClient.from('packlisten_positionen').insert([payload]);
        if (error) return showToast('Fehler beim Hinzufügen: ' + error.message, 'error');
        showToast('Position hinzugefügt!');
    }

    closeModal('packItemModal');
    if ($('pack-pos-id')) $('pack-pos-id').value = '';
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
    autoFehlbestandListe = [];
    eigeneVorschlaegeListe = [];
    manuelleEintraegeListe = [];
    const bestandMap = {}, nachkaufSet = new Set(), bedarfMap = {}, eigeneMap = {};

    aktuelleDaten.forEach(b => {
        const m = Number(b.menge);
        if (m === BESTAND_STRICH_NACHKAUF) nachkaufSet.add(String(b.artikel_id));
        else if (m >= 0) bestandMap[b.artikel_id] = (bestandMap[b.artikel_id] || 0) + (b.ist_menge >= 0 ? b.ist_menge : m);
    });

    packlistenPositionen.forEach(p => {
        if (p.artikel_id) bedarfMap[p.artikel_id] = (bedarfMap[p.artikel_id] || 0) + Number(p.menge);
        else if (p.eigener_name) eigeneMap[p.eigener_name] = (eigeneMap[p.eigener_name] || 0) + Number(p.menge);
    });

    alleArtikelInfos.forEach(art => {
        const bestand = nachkaufSet.has(String(art.id)) ? 0 : (bestandMap[art.id] || 0);
        const bedarf = bedarfMap[art.id] || 0;
        if (nachkaufSet.has(String(art.id))) {
            autoFehlbestandListe.push({ artikel: art.name, menge: Math.max(1, bedarf), grund: 'Nachkauf markiert (🔴)' });
        } else if (bedarf > bestand) {
            autoFehlbestandListe.push({ artikel: art.name, menge: bedarf - bestand, grund: 'Fehlt im Lager für Packliste' });
        }
    });

    const autoEl = $('auto-kauf-liste');
    if (autoEl) {
        autoEl.innerHTML = autoFehlbestandListe.length ? 
            autoFehlbestandListe.map(i => `<li><strong>${i.menge}x</strong> ${escapeHtml(i.artikel)} <small style="color:#7f8c8d;">(${i.grund})</small></li>`).join('') : 
            '<li style="color:#27ae60;">Alles grün! Keine Fehlbestände.</li>';
    }

    const eigeneEl = $('eigene-kauf-liste');
    if (eigeneEl) {
        eigeneEl.innerHTML = Object.entries(eigeneMap).map(([name, m], idx) => {
            eigeneVorschlaegeListe.push({ artikel: name, menge: m, grund: 'Sonderposten Packliste' });
            return `<li style="margin-bottom:6px;"><label style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="checkbox" class="eigene-kauf-check" data-index="${idx}" checked onchange="aktualisiereEinkaufslisteAuswahl()"><span>${m}x ${escapeHtml(name)}</span></label></li>`;
        }).join('') || '<li style="color:#7f8c8d;">Keine Sonderposten in Packlisten.</li>';
    }

    const manEl = $('manuell-kauf-liste');
    if (manEl) manEl.innerHTML = '';

    aktualisiereEinkaufslisteAuswahl();
    openModalById('kauflisteModal');
}

function aktualisiereEinkaufslisteAuswahl() {
    const ausgewaehlt = Array.from(document.querySelectorAll('.eigene-kauf-check:checked'))
        .map(chk => eigeneVorschlaegeListe[Number(chk.dataset.index)])
        .filter(Boolean);
    einkaufslisteArray = [...autoFehlbestandListe, ...ausgewaehlt, ...manuelleEintraegeListe];
}

function manuellAufZettel() {
    const n = $('manuell-kauf-name')?.value.trim();
    const m = werteMengeAus($('manuell-kauf-menge')?.value) || 1;
    if (!n || m <= 0) return;
    manuelleEintraegeListe.push({ artikel: n, menge: m, grund: 'Manuell hinzugefügt' });
    aktualisiereEinkaufslisteAuswahl();
    const manEl = $('manuell-kauf-liste');
    if (manEl) manEl.innerHTML += `<li>${m}x ${escapeHtml(n)}</li>`;
    if ($('manuell-kauf-name')) $('manuell-kauf-name').value = '';
    if ($('manuell-kauf-menge')) $('manuell-kauf-menge').value = '1';
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
// 12. REGAL-QR & FEEDBACK
// =========================================================================

function oeffneQrGeneratorFenster() { window.open('?qrgen=1', '_blank'); }

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
// =========================================================================
// 1. KONFIGURATION & GLOBALE ZUSTÄNDE
// =========================================================================
const SUPABASE_URL = 'https://trilager-api.pius-s.de';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InRyaWxhZ2VyIiwiaWF0IjoxNzg1ODA3MzI1LCJleHAiOjIxMDExNjczMjV9.COsEZ-KOGycjE2S1eALGohmmjosW8CZs038jezg6lSU';

const STORAGE_KEYS = {
    SESSION: 'trilager_local_session_v2',
    ATTEMPTS: 'trilager_login_attempts_v1',
    LOCK: 'trilager_login_lock_until_v1',
    ONBOARDING: 'lager_onboarding_v1_gesehen',
    KISTEN_BENUTZER: 'trilager_kisten_aktiver_benutzer_v1'
};

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_DURATION_MS = 5 * 60 * 1000;
const LOCAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TABLES = { FORMULAR: 'formular_antworten' };
const BESTAND_STRICH_AUSREICHEND = -2;
const BESTAND_STRICH_NACHKAUF = -3;

const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

// App-Datenzustände
let aktuelleDaten = [], packlisten = [], packlistenPositionen = [], alleArtikelInfos = [], alleLagerorte = [];
let alleBenutzerVorlagen = [], offeneEntnahmen = [], auditLogs = [];
let isEditMode = false, isEventEditMode = false, aktuellerModus = 'lager';
let offeneGruppen = new Set(), isAllOpen = false, sortAscending = true, zeigeAlleArtikel = false;
let aktiverRegalFilter = '', kistenAnsichtFilter = 'alle';
let kistenEtikettenAuswahlIds = new Set();
let einkaufslisteArray = [], autoFehlbestandListe = [], eigeneVorschlaegeListe = [], manuelleEintraegeListe = [];

// Kisten-, Scan-, Such- & Ausklapp-Zustände
let kistenCheckAktuelleId = '';
let aktiverQrScanner = null, aktiverNfcModus = null, nfcAbortController = null;
let scanSperre = { kisten: false, rueckgabe: false };
let aktiverKistenBenutzer = null, unterwegsRefreshInterval = null;
let aktiverTeilrueckgabeUserKey = null, aktiverTeilrueckgabeItems = [];
let kisteUnendlichOffen = false, kistenNurUnendlichOffen = false;
let kistenArtikelSucheAuswahlId = null;

// Klick-Batching & Mutex
const pendingArtikelUpdates = new Map();
let kisteAktionInArbeit = false;

// =========================================================================
// 2. HELFER- & PARSER-FUNKTIONEN
// =========================================================================
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}

function showToast(message, type = 'success') {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
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
    setTimeout(() => { if (!el.classList.contains('modal-visible')) el.style.display = 'none'; }, 220);
}

function populateSelect(selectEl, items, { valueKey = 'id', labelKey = 'name', defaultOption = null, selectedValue = null, formatLabel = null } = {}) {
    if (!selectEl) return;
    const current = selectedValue !== null ? selectedValue : selectEl.value;
    selectEl.innerHTML = defaultOption ? `<option value="">${defaultOption}</option>` : '';
    (items || []).forEach(item => {
        const val = typeof item === 'object' ? item[valueKey] : item;
        const text = formatLabel ? formatLabel(item) : (typeof item === 'object' ? item[labelKey] : item);
        selectEl.add(new Option(text, val));
    });
    if (current && Array.from(selectEl.options).some(o => o.value === String(current))) {
        selectEl.value = current;
    }
}

function werteMengeAus(eingabe) {
    if (eingabe === undefined || eingabe === null) return 0;
    const clean = String(eingabe).replace(/[^0-9+\-*/().]/g, '');
    if (!clean) return 0;
    try {
        let pos = 0;
        const parseFactor = () => {
            if (clean[pos] === '(') { pos++; const v = parseExpr(); pos++; return v; }
            if (clean[pos] === '-') { pos++; return -parseFactor(); }
            if (clean[pos] === '+') { pos++; return parseFactor(); }
            const start = pos;
            while (pos < clean.length && /[0-9.]/.test(clean[pos])) pos++;
            return parseFloat(clean.slice(start, pos)) || 0;
        };
        const parseTerm = () => {
            let v = parseFactor();
            while (clean[pos] === '*' || clean[pos] === '/') {
                const op = clean[pos++];
                const rhs = parseFactor();
                v = op === '*' ? v * rhs : v / rhs;
            }
            return v;
        };
        const parseExpr = () => {
            let v = parseTerm();
            while (clean[pos] === '+' || clean[pos] === '-') {
                const op = clean[pos++];
                const rhs = parseTerm();
                v = op === '+' ? v + rhs : v - rhs;
            }
            return v;
        };
        const res = parseExpr();
        return Number.isFinite(res) ? Math.round(res) : 0;
    } catch { return 0; }
}

function extrahiereRegalName(text) {
    const m = String(text || '').trim().match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : String(text || '').trim();
}

function normalisiereRegalText(text) {
    return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function vergleicheRegalNamen(a, b, sortFactor = 1) {
    return extrahiereRegalName(a).localeCompare(extrahiereRegalName(b), 'de', { numeric: true, sensitivity: 'base' }) * sortFactor;
}

function textEnthaeltRegal(text, regalName) {
    const nReg = normalisiereRegalText(regalName), nTxt = normalisiereRegalText(text);
    if (!nReg || !nTxt) return false;
    if (nTxt.includes(`(${nReg})`)) return true;
    return new RegExp(`(^|[^a-z0-9])${nReg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(nTxt) || (nReg.length > 3 && nTxt.includes(nReg));
}

function ermittleRegalSchluessel(bestaende) {
    return (bestaende || []).map(b => extrahiereRegalName(b.lagerorte?.name || '')).filter(Boolean).sort(vergleicheRegalNamen)[0] || '';
}

function formatArtikelId(id) {
    const n = Number(id);
    return Number.isFinite(n) ? '#' + String(n).padStart(5, '0') : String(id || '–');
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
    const infBtn = row.querySelector('.bestand-btn-inf'), minusBtn = row.querySelector('.bestand-btn-minus');
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
        const isWarn = status === 'strich-warn' || nachkauf;
        minusBtn.classList.toggle('active-minus-ok', status === 'strich-ok' && !nachkauf);
        minusBtn.classList.toggle('active-minus-warn', isWarn);
        minusBtn.style.background = isWarn ? '#c0392b' : (status === 'strich-ok' ? '#27ae60' : '#95a5a6');
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

async function dbAudit(payload, ereignis = 'entnahme') {
    try {
        await dbClient.from('lager_entnahme_audit').insert([{ ...payload, ereignis, created_at: new Date().toISOString() }]);
    } catch (e) {
        console.warn('Audit-Insert ignoriert:', e);
    }
}

async function syncEntnahme(entId, mats) {
    const saubereMats = mats.filter(m => (Array.isArray(m.artikel) && m.artikel.length > 0) || m.ganze_kiste);
    if (!saubereMats.length) {
        await dbClient.from('lager_entnahmen').delete().eq('id', entId);
        return [];
    }
    await dbClient.from('lager_entnahmen').update({ materialien: saubereMats }).eq('id', entId);
    return saubereMats;
}

function matchesArtikel(a, criteria) {
    if (criteria.bestandId && a.bestand_id && Number(a.bestand_id) === Number(criteria.bestandId)) return true;
    if (criteria.artikelId && a.artikel_id && Number(a.artikel_id) === Number(criteria.artikelId)) return true;
    if (criteria.name && a.name && a.name.trim().toLowerCase() === criteria.name.trim().toLowerCase()) return true;
    return false;
}

// =========================================================================
// 3. AUTH & SESSION
// =========================================================================
function pruefeLoginSperre() {
    try {
        const lockUntil = Number(window.localStorage.getItem(STORAGE_KEYS.LOCK)) || 0;
        const now = Date.now();
        if (lockUntil > now) return { gesperrt: true, minuten: Math.ceil((lockUntil - now) / 60000) };
        if (lockUntil > 0) {
            window.localStorage.removeItem(STORAGE_KEYS.LOCK);
            window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
        }
    } catch {}
    return { gesperrt: false };
}

function registriereLoginFehlversuch() {
    try {
        const attempts = (Number(window.localStorage.getItem(STORAGE_KEYS.ATTEMPTS)) || 0) + 1;
        if (attempts >= MAX_LOGIN_ATTEMPTS) {
            const lockUntil = Date.now() + LOGIN_LOCK_DURATION_MS;
            window.localStorage.setItem(STORAGE_KEYS.LOCK, String(lockUntil));
            window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
            return { gesperrt: true, minuten: Math.ceil(LOGIN_LOCK_DURATION_MS / 60000) };
        }
        window.localStorage.setItem(STORAGE_KEYS.ATTEMPTS, String(attempts));
        return { gesperrt: false, verbleibend: MAX_LOGIN_ATTEMPTS - attempts };
    } catch {
        return { gesperrt: false, verbleibend: 0 };
    }
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
        if (errEl) { errEl.style.display = 'block'; errEl.innerText = `Zu viele Fehlversuche! Bitte in ca. ${sperre.minuten} Minute(n) erneut versuchen.`; }
        return;
    }
    const p = $('login-password').value;
    if (!p) {
        if (errEl) { errEl.style.display = 'block'; errEl.innerText = 'Bitte gib ein Passwort ein!'; }
        return;
    }

    const { data, error } = await dbClient.rpc('login_user', { p_password: p });
    if (error || !data || data.length === 0) {
        const status = registriereLoginFehlversuch();
        if (errEl) {
            errEl.style.display = 'block';
            errEl.innerText = status.gesperrt ? `Zu viele Fehlversuche! Login für ${status.minuten} Minuten gesperrt.` : `Falsches Passwort! Noch ${status.verbleibend} Versuch(e) übrig.`;
        }
    } else {
        window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
        window.localStorage.removeItem(STORAGE_KEYS.LOCK);
        if (errEl) errEl.style.display = 'none';
        $('login-password').value = '';
        $('login-overlay').style.display = 'none';
        speichereLokaleSession({ username: data.username, token: data.token });
        showToast('Erfolgreich angemeldet!');
        ladeKistenBenutzerSession();
        await ladeAlles();
        if (!window.localStorage.getItem(STORAGE_KEYS.ONBOARDING)) openModalById('onboardingModal');
    }
}

function handleLogout() {
    stoppeUnterwegsAutoRefresh();
    speichereKistenBenutzerSession(null);
    window.localStorage.removeItem(STORAGE_KEYS.SESSION);
    setzeAuthToken(null);
    $('login-overlay').style.display = 'flex';
}

function oeffneOnboarding() { openModalById('onboardingModal'); }
function schliesseOnboarding() { closeModal('onboardingModal'); window.localStorage.setItem(STORAGE_KEYS.ONBOARDING, '1'); }
function openRechtliches(e, mid) { if (e) e.preventDefault(); openModalById(mid); }

// =========================================================================
// 4. DATEN LADEN & FILTER
// =========================================================================
async function ladeAlles() {
    try {
        await Promise.all([ladeLagerorte(), ladePacklistenDaten(), ladeBestand(), ladeEntnahmeDaten()]);
        try {
            const einJahrVorher = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
            await dbClient.from('lager_entnahmen').delete().lt('created_at', einJahrVorher);
        } catch {}
    } catch (err) {
        console.error('Fehler beim Initialisieren der Daten:', err);
    }
    wendeFilterAn();
    if (aktuellerModus === 'event') zeigePackliste();
    if (aktuellerModus === 'kisten') setzeKistenAnsichtFilter(kistenAnsichtFilter);
}

async function ladeLagerorte() {
    const { data } = await dbClient.from('lagerorte').select('*').order('name');
    alleLagerorte = data || [];
    document.querySelectorAll('.new-ort').forEach(sel => populateSelect(sel, alleLagerorte));
}

async function ladePacklistenDaten() {
    const [{ data: listData }, { data: posData }] = await Promise.all([
        dbClient.from('packlisten').select('*').order('name'),
        dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie, einheit)')
    ]);
    packlisten = listData || [];
    packlistenPositionen = posData || [];
    populateSelect($('packlisten-auswahl'), packlisten, { defaultOption: '-- Wähle Resort / Packliste --' });
}

async function ladeBestand() {
    const [{ data: alleArt }, { data }] = await Promise.all([
        dbClient.from('artikel').select('*').order('name'),
        dbClient.from('bestand').select(`
            id, menge, alte_menge, created_at, artikel_id, lagerort_id, 
            artikel (id, name, kategorie, einheit, kommentar, wichtig, typ), 
            lagerorte (id, name, nfc_code)
        `).order('id')
    ]);
    alleArtikelInfos = alleArt || [];

    aktuelleDaten = (data || []).map(z => {
        const m = Number(z.menge), alt = z.alte_menge !== null && z.alte_menge !== undefined ? Number(z.alte_menge) : null;
        const isSpecial = m === -1 || m === -2 || m === -3;
        const soll = isSpecial ? m : ((alt !== null && alt >= 0 && alt >= m) ? alt : m);
        return { ...z, soll_menge: soll, ist_menge: isSpecial ? m : m };
    });

    const katDropdown = $('kategorie-filter'), datalist = $('kategorie-liste'), comboDropdown = $('ort-filter-combo');
    const artikelDatalist = $('kategorie-artikel-liste');
    const kategorien = new Set(), regale = new Set();

    aktuelleDaten.forEach(z => {
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

async function ladeEntnahmeDaten() {
    try {
        const [{ data: bData }, { data: eData }, { data: aData }] = await Promise.all([
            dbClient.from('lager_entnahme_benutzer_vorlagen').select('*').order('name'),
            dbClient.from('lager_entnahmen').select('*').order('created_at', { ascending: false }),
            dbClient.from('lager_entnahme_audit').select('*').order('created_at', { ascending: false }).limit(100)
        ]);
        alleBenutzerVorlagen = bData || [];
        offeneEntnahmen = eData || [];
        auditLogs = aData || [];
    } catch (err) {
        console.warn('Hinweis beim Laden der Entnahmedaten:', err);
    }
}

// =========================================================================
// 5. KISTEN-, BENUTZER- & ENTNAHME-SYSTEM
// =========================================================================
function ladeKistenBenutzerSession() {
    try {
        const raw = window.sessionStorage.getItem(STORAGE_KEYS.KISTEN_BENUTZER);
        aktiverKistenBenutzer = raw ? JSON.parse(raw) : null;
    } catch { aktiverKistenBenutzer = null; }
    aktualisiereKistenBenutzerUI();
}

function speichereKistenBenutzerSession(user) {
    aktiverKistenBenutzer = user;
    try {
        if (user) window.sessionStorage.setItem(STORAGE_KEYS.KISTEN_BENUTZER, JSON.stringify(user));
        else window.sessionStorage.removeItem(STORAGE_KEYS.KISTEN_BENUTZER);
    } catch {}
    aktualisiereKistenBenutzerUI();
}

function aktualisiereKistenBenutzerUI() {
    const banner = $('kisten-benutzer-banner'), nameEl = $('kisten-aktiver-benutzer-name');
    const badgeEl = $('kisten-aktiver-benutzer-badge'), iconEl = $('kisten-benutzer-icon');
    if (!banner || !nameEl) return;

    if (!aktiverKistenBenutzer) {
        nameEl.innerText = 'Kein Benutzer ausgewählt';
        nameEl.style.color = '#c0392b';
        if (badgeEl) badgeEl.innerHTML = '';
        if (iconEl) iconEl.innerText = '⚠️';
        banner.style.background = '#fef5e7';
        banner.style.borderColor = '#f9e79f';
    } else if (aktiverKistenBenutzer.isHelper) {
        nameEl.innerText = aktiverKistenBenutzer.name;
        nameEl.style.color = '#27ae60';
        if (badgeEl) badgeEl.innerHTML = ' <span class="audit-badge rueckgabe" style="margin-left:6px;">Nur Einbuchen</span>';
        if (iconEl) iconEl.innerText = '🤝';
        banner.style.background = '#edf8f0';
        banner.style.borderColor = '#a3e4d7';
    } else {
        nameEl.innerText = aktiverKistenBenutzer.name;
        nameEl.style.color = '#2c3e50';
        if (badgeEl) badgeEl.innerHTML = aktiverKistenBenutzer.kontakt ? ` <small style="color:#7f8c8d; font-weight:normal;">(${escapeHtml(aktiverKistenBenutzer.kontakt)})</small>` : '';
        if (iconEl) iconEl.innerText = '👤';
        banner.style.background = '#edf4fc';
        banner.style.borderColor = '#c8ddf6';
    }
}

function oeffneKistenBenutzerModal() {
    renderKistenBenutzerAuswahlListe();
    const wrap = $('kisten-neuer-benutzer-form');
    if (wrap) wrap.style.display = 'none';
    if ($('kisten-neuer-benutzer-name')) $('kisten-neuer-benutzer-name').value = '';
    if ($('kisten-neuer-benutzer-kontakt')) $('kisten-neuer-benutzer-kontakt').value = '';
    openModalById('kistenBenutzerModal');
}

function schliesseKistenBenutzerModal() { closeModal('kistenBenutzerModal'); }
function toggleNeuerBenutzerForm() {
    const el = $('kisten-neuer-benutzer-form');
    if (!el) return;
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
    if (el.style.display === 'block') $('kisten-neuer-benutzer-name')?.focus();
}

function waehleKistenBenutzer(vorlageId) {
    const v = alleBenutzerVorlagen.find(b => String(b.id) === String(vorlageId));
    if (!v) return;
    speichereKistenBenutzerSession({ id: v.id, name: v.name, kontakt: v.kontakt || '', isHelper: false });
    schliesseKistenBenutzerModal();
    showToast(`👤 Angemeldet als: ${v.name}`);
    if (kistenCheckAktuelleId) oeffneKistenCheck(kistenCheckAktuelleId);
}

function waehleHelferAccount() {
    speichereKistenBenutzerSession({ id: null, name: 'Helfer', kontakt: '', isHelper: true });
    schliesseKistenBenutzerModal();
    showToast('🤝 Als Helfer angemeldet (Ausbuchen gesperrt)');
    if (kistenCheckAktuelleId) oeffneKistenCheck(kistenCheckAktuelleId);
}

function kistenBenutzerZuruecksetzen() {
    speichereKistenBenutzerSession(null);
    showToast('Benutzer zurückgesetzt.');
    oeffneKistenBenutzerModal();
}

async function speichereUndWaehleNeuenBenutzer() {
    const name = ($('kisten-neuer-benutzer-name')?.value || '').trim();
    const kontakt = ($('kisten-neuer-benutzer-kontakt')?.value || '').trim();
    if (!name) return showToast('Bitte einen Namen eingeben!', 'warning');

    const { data, error } = await dbClient.from('lager_entnahme_benutzer_vorlagen').insert([{ name, kontakt }]).select();
    if (error) return showToast('Fehler beim Anlegen: ' + error.message, 'error');

    await ladeEntnahmeDaten();
    const neu = (data && data[0]) ? data[0] : { id: null, name, kontakt };
    speichereKistenBenutzerSession({ id: neu.id, name: neu.name, kontakt: neu.kontakt || '', isHelper: false });
    schliesseKistenBenutzerModal();
    showToast(`👤 Angelegt & ausgewählt: ${name}`);
    if (kistenCheckAktuelleId) oeffneKistenCheck(kistenCheckAktuelleId);
}

async function loescheBenutzerVorlage(id, name, ev) {
    if (ev) ev.stopPropagation();
    if (!confirm(`Möchtest du "${name}" wirklich löschen?`)) return;

    const { error } = await dbClient.from('lager_entnahme_benutzer_vorlagen').delete().eq('id', id);
    if (error) return showToast('Fehler beim Löschen: ' + error.message, 'error');

    showToast(`Benutzer "${name}" gelöscht.`);
    if (aktiverKistenBenutzer && String(aktiverKistenBenutzer.id) === String(id)) speichereKistenBenutzerSession(null);
    await ladeEntnahmeDaten();
    renderKistenBenutzerAuswahlListe();
}

function renderKistenBenutzerAuswahlListe() {
    const container = $('kisten-benutzer-liste');
    if (!container) return;
    const suchText = ($('kisten-benutzer-such-input')?.value || '').toLowerCase().trim();
    const liste = alleBenutzerVorlagen.filter(v => !suchText || (v.name || '').toLowerCase().includes(suchText) || (v.kontakt || '').toLowerCase().includes(suchText));

    if (!liste.length) {
        container.innerHTML = '<p style="text-align:center; color:#7f8c8d; padding:15px;">Keine passenden Personen gefunden.</p>';
        return;
    }

    container.innerHTML = liste.map(v => {
        const isCurrent = aktiverKistenBenutzer && !aktiverKistenBenutzer.isHelper && String(aktiverKistenBenutzer.id) === String(v.id);
        const escapedName = escapeHtml(v.name).replace(/'/g, "\\'");
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border:1px solid ${isCurrent ? '#3498db' : '#e2e8f0'}; background:${isCurrent ? '#ebf5fb' : '#fff'}; border-radius:8px; margin-bottom:8px; gap:8px;">
                <div style="flex:1; cursor:pointer;" onclick="waehleKistenBenutzer('${v.id}')">
                    <strong style="color:#2c3e50; font-size:1.02em;">👤 ${escapeHtml(v.name)}</strong>
                    ${v.kontakt ? `<div style="font-size:0.82em; color:#7f8c8d; margin-top:2px;">📞 ${escapeHtml(v.kontakt)}</div>` : ''}
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <button type="button" class="btn" style="background:${isCurrent ? '#2980b9' : '#27ae60'}; padding:6px 12px; font-size:0.85em; width:auto; min-height:36px;" onclick="waehleKistenBenutzer('${v.id}')">${isCurrent ? '✓ Aktiv' : 'Auswählen'}</button>
                    <button type="button" class="btn" style="background:#e74c3c; padding:6px 10px; font-size:0.85em; width:auto; min-height:36px;" onclick="loescheBenutzerVorlage('${v.id}', '${escapedName}', event)" title="Benutzer löschen">🗑️</button>
                </div>
            </div>`;
    }).join('');
}

function gibKistenBestand(lid) {
    return aktuelleDaten.filter(z => String(z.lagerort_id) === String(lid)).sort((a, b) => (a.artikel?.name || '').localeCompare(b.artikel?.name || '', 'de'));
}

function ermittleAlleKistenEntnahmen(lid) {
    return offeneEntnahmen.filter(e => Array.isArray(e.materialien) && e.materialien.some(m => String(m.kiste_id) === String(lid)));
}

function ermittleKistenStatusCell(lid, bestand) {
    const entnahmen = ermittleAlleKistenEntnahmen(lid);
    const fehlt = bestand.some(b => Number(b.soll_menge) > 0 && Number(b.ist_menge) < Number(b.soll_menge));

    if (!entnahmen.length) return fehlt ? '<span style="color:#c0392b; font-weight:bold;">🔴 Teile fehlen</span>' : '<span style="color:#27ae60; font-weight:bold;">✔️ Vollzählig</span>';
    if (entnahmen.length === 1 && entnahmen[0].materialien?.some(m => String(m.kiste_id) === String(lid) && m.ganze_kiste)) {
        return `<span style="color:#d35400; font-weight:bold;">📤 Bei ${escapeHtml(entnahmen[0].name)}</span>`;
    }
    return '<span style="color:#e67e22; font-weight:bold;">⚠️ Teilentnahme (siehe Prüfen)</span>';
}

function extrahiereEntnahmePositionen(ent) {
    const res = [];
    (Array.isArray(ent.materialien) ? ent.materialien : []).forEach((m, matIdx) => {
        if (Array.isArray(m.artikel) && m.artikel.length > 0) {
            m.artikel.forEach((a, artIdx) => {
                res.push({
                    entnahmeId: ent.id, matIdx, artIdx,
                    kisteId: m.kiste_id ? Number(m.kiste_id) : null,
                    kisteName: m.kiste_name || 'Kiste',
                    ganzeKiste: Boolean(m.ganze_kiste),
                    bestandId: a.bestand_id ? Number(a.bestand_id) : null,
                    artikelId: a.artikel_id ? Number(a.artikel_id) : null,
                    name: a.name || 'Artikel',
                    menge: Number(a.menge) || 1,
                    typ: a.typ || 'zaehlbar'
                });
            });
        } else {
            res.push({
                entnahmeId: ent.id, matIdx, artIdx: null,
                kisteId: m.kiste_id ? Number(m.kiste_id) : null,
                kisteName: m.kiste_name || null,
                ganzeKiste: Boolean(m.ganze_kiste),
                bestandId: m.bestand_id ? Number(m.bestand_id) : null,
                artikelId: m.artikel_id ? Number(m.artikel_id) : null,
                name: m.ganze_kiste ? `${m.kiste_name} (Ganze Kiste)` : (m.name || m.label || 'Material'),
                menge: Number(m.menge) || 1,
                typ: m.ganze_kiste ? 'kiste' : (m.typ || 'zaehlbar')
            });
        }
    });
    return res;
}

// Bereinigt automatisch verwaiste Entnahmen, falls mehr gebucht war als physisch fehlt
async function bereinigeKistenEntnahmenUeberhang(lid) {
    const bestand = gibKistenBestand(lid);
    let gabAenderung = false;

    for (const b of bestand) {
        const soll = Number(b.soll_menge) || 0, ist = Number(b.ist_menge) || 0;
        if (soll <= 0 || ist < 0) continue;
        const maxFehlend = Math.max(0, soll - ist);

        let totalGebucht = 0;
        const matchingEntries = [];

        offeneEntnahmen.forEach(ent => {
            (Array.isArray(ent.materialien) ? ent.materialien : []).forEach(m => {
                if (Number(m.kiste_id) !== Number(lid) || !Array.isArray(m.artikel)) return;
                m.artikel.forEach(a => {
                    if (matchesArtikel(a, { bestandId: b.id, artikelId: b.artikel_id, name: b.artikel?.name })) {
                        totalGebucht += Number(a.menge) || 0;
                        matchingEntries.push({ ent, a });
                    }
                });
            });
        });

        if (totalGebucht > maxFehlend) {
            let ueberhang = totalGebucht - maxFehlend;
            matchingEntries.sort((x, y) => new Date(y.ent.created_at) - new Date(x.ent.created_at));

            const touchedEnts = new Set();
            for (const item of matchingEntries) {
                if (ueberhang <= 0) break;
                const abzug = Math.min(ueberhang, item.a.menge);
                item.a.menge -= abzug;
                ueberhang -= abzug;
                touchedEnts.add(item.ent);
                gabAenderung = true;
            }

            for (const ent of touchedEnts) {
                ent.materialien.forEach(m => { if (Array.isArray(m.artikel)) m.artikel = m.artikel.filter(a => a.menge > 0); });
                ent.materialien = await syncEntnahme(ent.id, ent.materialien);
            }
        }
    }
    if (gabAenderung) await ladeEntnahmeDaten();
}

async function oeffneKistenCheck(lid) {
    const ort = alleLagerorte.find(o => String(o.id) === String(lid));
    if (!ort) return;
    kistenCheckAktuelleId = lid;
    kisteUnendlichOffen = false;

    $('kisten-check-titel').innerText = `📦 ${ort.name}`;
    $('kisten-check-code').innerText = `Kisten-ID: #${ort.id}`;

    await bereinigeKistenEntnahmenUeberhang(lid);

    const ausbuchenBtn = $('kiste-ausbuchen-btn');
    if (ausbuchenBtn) {
        const isH = aktiverKistenBenutzer?.isHelper;
        ausbuchenBtn.disabled = Boolean(isH);
        ausbuchenBtn.style.opacity = isH ? '0.4' : '1';
        ausbuchenBtn.style.cursor = isH ? 'not-allowed' : 'pointer';
        ausbuchenBtn.title = isH ? 'Helfer können keine Kisten ausbuchen' : 'Ganze Kiste ausbuchen';
    }

    const boxEntnahmen = ermittleAlleKistenEntnahmen(lid);
    const banner = $('kiste-ausgeliehen-banner');
    if (banner) {
        if (!boxEntnahmen.length) {
            banner.style.display = 'none';
        } else {
            banner.style.display = 'block';
            const personGroups = new Map();
            boxEntnahmen.forEach(ent => {
                const userKey = ent.benutzer_vorlage_id ? String(ent.benutzer_vorlage_id) : (ent.name || 'unbekannt').trim().toLowerCase();
                if (!personGroups.has(userKey)) {
                    personGroups.set(userKey, { name: ent.name || 'Unbekannt', kontakt: ent.kontakt || '', datum: new Date(ent.created_at), artikelMap: new Map(), ganzeKiste: false });
                }
                const grp = personGroups.get(userKey);
                if (new Date(ent.created_at) > grp.datum) grp.datum = new Date(ent.created_at);

                extrahiereEntnahmePositionen(ent).filter(p => String(p.kisteId) === String(lid)).forEach(p => {
                    if (p.ganzeKiste) { grp.ganzeKiste = true; }
                    else {
                        const k = p.artikelId ? 'art_' + p.artikelId : 'n_' + p.name;
                        const ex = grp.artikelMap.get(k) || { name: p.name, menge: 0 };
                        ex.menge += p.menge;
                        grp.artikelMap.set(k, ex);
                    }
                });
            });

            let bHtml = `⚠️ <strong>Offene Entnahmen aus dieser Kiste (${personGroups.size} Person(en)):</strong><div style="margin-top:6px; display:flex; flex-direction:column; gap:6px;">`;
            personGroups.forEach(grp => {
                const details = grp.ganzeKiste ? '<strong>Ganze Kiste entnommen</strong>' : Array.from(grp.artikelMap.values()).map(i => `<strong>${i.menge}x</strong> ${escapeHtml(i.name)}`).join(', ') || 'Teilentnahme';
                bHtml += `
                    <div style="font-size:0.92em; padding:4px 0; border-bottom:1px dashed #f0ad4e;">
                        👤 <strong>${escapeHtml(grp.name)}</strong>: ${details} <span style="color:#7f8c8d; font-size:0.85em;">(letzte Entnahme: ${grp.datum.toLocaleString('de-DE')})</span>
                        ${grp.kontakt ? ` &bull; 📞 ${escapeHtml(grp.kontakt)}` : ''}
                    </div>`;
            });
            banner.innerHTML = bHtml + '</div>';
        }
    }

    renderKistenInhaltListe(lid);
    $('kisten-check-edit-bereich').style.display = 'none';
    $('kiste-edit-toggle-btn').innerText = '⚙️ Inhalt bearbeiten';
    openModalById('kistenCheckModal');
}

function erzeugeKistenItemCard(z, isHelper) {
    const pending = pendingArtikelUpdates.get(z.id);
    const ist = pending ? pending.targetMenge : Number(z.ist_menge);
    const soll = Number(z.soll_menge);
    const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
    const istUnendlich = (ist === -1);
    const istVerbrauch = !istUnendlich && ((z.artikel?.typ === 'verbrauch') || (ist === BESTAND_STRICH_AUSREICHEND || ist === BESTAND_STRICH_NACHKAUF));
    const einheit = z.artikel?.einheit || 'Stück';

    const card = document.createElement('div');
    card.className = `kiste-item-card ${fehlt > 0 ? 'fehlend' : ''}`;
    card.id = `kiste-item-card-${z.id}`;

    let statusText = '';
    if (istUnendlich) statusText = '<span style="font-size:1.1em; font-weight:bold; color:#7f8c8d;">∞</span> (Unbegrenzt vorhanden)';
    else if (ist === -2) statusText = '<span class="bestand-status-pill ok">-</span> Ausreichend vorhanden';
    else if (ist === -3) statusText = '<span class="bestand-status-pill warn">-</span> 🔴 Nachkaufen nötig';
    else {
        statusText = `Im Lager: <strong>${ist}</strong> von max. <strong>${soll}</strong> ${einheit}`;
        statusText += fehlt > 0 ? ` &bull; <span style="color:#c0392b; font-weight:bold;">${fehlt} fehlen unterwegs</span>` : ` &bull; <span style="color:#27ae60;">✅ Vollzählig</span>`;
    }

    let bedienHtml = '';
    if (istUnendlich) {
        bedienHtml = '';
    } else if (istVerbrauch) {
        bedienHtml = `
            <div style="display:flex; gap:6px;">
                <button class="btn" style="background:#27ae60; padding:6px 10px; font-size:0.85em; width:auto; min-height:36px;" onclick="setzeKistenVerbrauchStatus(${z.id}, -2)">🟢 Ausreichend</button>
                <button class="btn" style="background:#c0392b; padding:6px 10px; font-size:0.85em; width:auto; min-height:36px;" onclick="setzeKistenVerbrauchStatus(${z.id}, -3)">🔴 Nachkaufen</button>
            </div>`;
    } else {
        const canMinus = ist > 0 && !isHelper, canPlus = soll <= 0 || ist < soll;
        bedienHtml = `
            <button class="btn btn-kiste-minus" style="background:#e74c3c; width:36px; min-width:36px; height:36px; padding:0; font-size:1.1em; ${!canMinus ? 'opacity:0.35; cursor:not-allowed;' : ''}" onclick="aendereArtikelMengeInKiste(${z.id}, -1)" ${!canMinus ? 'disabled' : ''}>−</button>
            <input type="text" id="kiste-menge-${z.id}" class="menge-input bestand-menge-input ${ist > 0 ? 'bestand-menge-ok' : 'bestand-menge-low'}" value="${ist}" onchange="speichereKisteMengeInput(${z.id}, this.value)" style="width:60px; height:36px;">
            <button class="btn btn-kiste-plus" style="background:#27ae60; width:36px; min-width:36px; height:36px; padding:0; font-size:1.1em; ${!canPlus ? 'opacity:0.35; cursor:not-allowed;' : ''}" onclick="aendereArtikelMengeInKiste(${z.id}, 1)" ${!canPlus ? 'disabled' : ''}>+</button>`;
    }

    card.innerHTML = `
        <div style="flex:1;">
            <div style="font-weight:bold; font-size:1.02em; color:#2c3e50;">${escapeHtml(z.artikel?.name || 'Unbekannt')}</div>
            <div class="kiste-item-subtext" style="font-size:0.85em; color:#555; margin-top:3px;">${statusText}</div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
            ${bedienHtml}
            <button class="btn" style="background:#e74c3c; padding:6px 10px; width:auto; min-height:36px; margin-left:6px;" onclick="entferneArtikelAusKiste(${z.id})" title="Aus dieser Kiste entfernen">🗑️</button>
        </div>`;
    return card;
}

function renderKistenInhaltListe(lid) {
    const wrapper = $('kisten-check-liste');
    if (!wrapper) return;
    wrapper.innerHTML = '';
    const bestand = gibKistenBestand(lid);

    if (!bestand.length) {
        wrapper.innerHTML = '<p style="color:#7f8c8d; text-align:center; padding:15px;">Diese Kiste hat noch keine zugeordneten Artikel.</p>';
        return;
    }

    const isHelper = aktiverKistenBenutzer?.isHelper;
    const endliche = bestand.filter(z => Number(z.ist_menge) !== -1);
    const unendliche = bestand.filter(z => Number(z.ist_menge) === -1);

    endliche.forEach(z => wrapper.appendChild(erzeugeKistenItemCard(z, isHelper)));

    if (unendliche.length > 0) {
        const toggleWrap = document.createElement('div');
        toggleWrap.style = 'margin: 10px 0;';
        toggleWrap.innerHTML = `
            <button type="button" class="btn" style="background:#64748b; font-size:0.88em; padding:8px 12px; width:100%; display:flex; justify-content:space-between; align-items:center;" onclick="toggleKisteUnendlicheArtikel()">
                <span>${kisteUnendlichOffen ? '▼' : '▶'} Unbegrenzte Artikel (${unendliche.length})</span>
                <small style="opacity:0.85;">${kisteUnendlichOffen ? 'Ausblenden' : 'Einblenden'}</small>
            </button>`;
        wrapper.appendChild(toggleWrap);

        if (kisteUnendlichOffen) {
            const unendlichBox = document.createElement('div');
            unendlichBox.style = 'display:flex; flex-direction:column; gap:8px;';
            unendliche.forEach(z => unendlichBox.appendChild(erzeugeKistenItemCard(z, isHelper)));
            wrapper.appendChild(unendlichBox);
        }
    }
}

function toggleKisteUnendlicheArtikel() {
    kisteUnendlichOffen = !kisteUnendlichOffen;
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

// -------------------------------------------------------------------------
// Schnelles Klick-Batching (Debounced Optimistic UI) für + / -
// -------------------------------------------------------------------------
function aendereArtikelMengeInKiste(bestandId, delta) {
    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;

    const inputEl = $(`kiste-menge-${bestandId}`);
    let currentVal;
    if (pendingArtikelUpdates.has(bestandId)) {
        currentVal = pendingArtikelUpdates.get(bestandId).targetMenge;
    } else if (inputEl && !Number.isNaN(parseInt(inputEl.value, 10))) {
        currentVal = parseInt(inputEl.value, 10);
    } else {
        currentVal = Number(eintrag.ist_menge);
    }

    if (currentVal < 0) return;

    const soll = Number(eintrag.soll_menge) || 0;
    const isHelper = aktiverKistenBenutzer?.isHelper;

    if (delta < 0) {
        if (currentVal <= 0) return showToast('Bereits 0 vorhanden – kann nicht weiter entnommen werden!', 'warning');
        if (!aktiverKistenBenutzer) { showToast('Bitte wähle zuerst einen Benutzer aus!', 'warning'); return oeffneKistenBenutzerModal(); }
        if (isHelper) return showToast('Helfer-Account: Ausbuchen ist gesperrt!', 'warning');
    } else if (delta > 0 && soll > 0 && currentVal >= soll) {
        return showToast(`Maximal ${soll} ${eintrag.artikel?.einheit || 'Stück'} möglich!`, 'warning');
    }

    const newTarget = Math.max(0, soll > 0 ? Math.min(soll, currentVal + delta) : currentVal + delta);
    if (newTarget === currentVal) return;

    const currentDelta = (pendingArtikelUpdates.get(bestandId)?.delta || 0) + (newTarget - currentVal);
    eintrag.ist_menge = newTarget;

    if (inputEl) { inputEl.value = newTarget; aktualisiereMengeEingabeFarbe(inputEl); }
    const card = $(`kiste-item-card-${bestandId}`);
    if (card) {
        const fehlt = (soll > 0 && newTarget >= 0) ? Math.max(0, soll - newTarget) : 0;
        card.classList.toggle('fehlend', fehlt > 0);
        const sub = card.querySelector('.kiste-item-subtext');
        if (sub) {
            sub.innerHTML = `Im Lager: <strong>${newTarget}</strong> von max. <strong>${soll}</strong> ${eintrag.artikel?.einheit || 'Stück'}` +
                (fehlt > 0 ? ` &bull; <span style="color:#c0392b; font-weight:bold;">${fehlt} fehlen unterwegs</span>` : ` &bull; <span style="color:#27ae60;">✅ Vollzählig</span>`);
        }
        const mBtn = card.querySelector('.btn-kiste-minus'), pBtn = card.querySelector('.btn-kiste-plus');
        if (mBtn && !isHelper) { mBtn.disabled = newTarget <= 0; mBtn.style.opacity = newTarget <= 0 ? '0.35' : '1'; mBtn.style.cursor = newTarget <= 0 ? 'not-allowed' : 'pointer'; }
        if (pBtn) { const pMax = soll > 0 && newTarget >= soll; pBtn.disabled = pMax; pBtn.style.opacity = pMax ? '0.35' : '1'; pBtn.style.cursor = pMax ? 'not-allowed' : 'pointer'; }
    }
    if (navigator.vibrate) navigator.vibrate(30);

    if (pendingArtikelUpdates.has(bestandId)) clearTimeout(pendingArtikelUpdates.get(bestandId).timer);
    const timer = setTimeout(() => flushPendingArtikelUpdate(bestandId), 500);

    pendingArtikelUpdates.set(bestandId, {
        timer, delta: currentDelta, targetMenge: newTarget, sollMenge: soll,
        artikelName: eintrag.artikel?.name || 'Artikel',
        artikelId: eintrag.artikel_id, kisteId: eintrag.lagerort_id, kisteName: eintrag.lagerorte?.name || 'Kiste'
    });
}

async function reduziereOffeneEntnahmenFuerArtikel(kisteId, bestandId, artikelId, artikelName, mengeZurueck) {
    let verbleibend = mengeZurueck;
    const kIdNum = Number(kisteId);

    const kandidaten = offeneEntnahmen.filter(e => Array.isArray(e.materialien) && e.materialien.some(m => Number(m.kiste_id) === kIdNum))
        .sort((a, b) => {
            const aIsU = aktiverKistenBenutzer && (String(a.benutzer_vorlage_id) === String(aktiverKistenBenutzer.id) || a.name === aktiverKistenBenutzer.name);
            const bIsU = aktiverKistenBenutzer && (String(b.benutzer_vorlage_id) === String(aktiverKistenBenutzer.id) || b.name === aktiverKistenBenutzer.name);
            return (bIsU ? 1 : 0) - (aIsU ? 1 : 0) || (new Date(b.created_at) - new Date(a.created_at));
        });

    for (const ent of kandidaten) {
        if (verbleibend <= 0) break;
        let geaendert = false;
        (ent.materialien || []).forEach(m => {
            if (verbleibend <= 0 || Number(m.kiste_id) !== kIdNum) return;
            if (Array.isArray(m.artikel)) {
                m.artikel.forEach(a => {
                    if (verbleibend <= 0) return;
                    if (matchesArtikel(a, { bestandId, artikelId, name: artikelName })) {
                        const abzug = Math.min(verbleibend, a.menge);
                        a.menge -= abzug;
                        verbleibend -= abzug;
                        geaendert = true;
                    }
                });
                m.artikel = m.artikel.filter(a => a.menge > 0);
            } else if (m.ganze_kiste) {
                m.ganze_kiste = false;
                geaendert = true;
            }
        });

        if (geaendert) {
            ent.materialien = await syncEntnahme(ent.id, ent.materialien);
            dbAudit({
                name: ent.name, kontakt: ent.kontakt, benutzer_vorlage_id: ent.benutzer_vorlage_id,
                materialien: [{ kiste_id: kIdNum, kiste_name: ent.materialien[0]?.kiste_name || 'Kiste', artikel: [{ bestand_id: bestandId, artikel_id: artikelId, name: artikelName, menge: mengeZurueck - verbleibend }] }]
            }, 'teilrueckgabe');
        }
    }
}

async function flushPendingArtikelUpdate(bestandId) {
    if (!pendingArtikelUpdates.has(bestandId)) return;
    const info = pendingArtikelUpdates.get(bestandId);
    pendingArtikelUpdates.delete(bestandId);
    if (info.delta === 0) return;

    try {
        const payload = { menge: info.targetMenge, created_at: new Date().toISOString() };
        if (info.sollMenge > 0) payload.alte_menge = info.sollMenge;
        await dbClient.from('bestand').update(payload).eq('id', bestandId);

        if (info.delta < 0 && aktiverKistenBenutzer && !aktiverKistenBenutzer.isHelper) {
            const entMenge = Math.abs(info.delta);
            const entnahmePayload = {
                name: aktiverKistenBenutzer.name, kontakt: aktiverKistenBenutzer.kontakt || '',
                benutzer_vorlage_id: aktiverKistenBenutzer.id || null,
                materialien: [{
                    kiste_id: Number(info.kisteId), kiste_name: info.kisteName, ganze_kiste: false,
                    artikel: [{ bestand_id: bestandId, artikel_id: info.artikelId, name: info.artikelName, menge: entMenge, typ: 'zaehlbar' }]
                }],
                created_at: new Date().toISOString()
            };
            await dbClient.from('lager_entnahmen').insert([entnahmePayload]);
            dbAudit(entnahmePayload, 'entnahme');
            showToast(`📤 ${entMenge}x "${info.artikelName}" an ${aktiverKistenBenutzer.name} ausgebucht!`);
        } else if (info.delta > 0) {
            await reduziereOffeneEntnahmenFuerArtikel(info.kisteId, bestandId, info.artikelId, info.artikelName, info.delta);
            showToast(`✅ ${info.delta}x "${info.artikelName}" wieder eingebucht.`);
        }
        await ladeAlles();
        if (kistenCheckAktuelleId) oeffneKistenCheck(kistenCheckAktuelleId);
    } catch (err) {
        console.error('Fehler beim Speichern:', err);
        showToast('Fehler beim Speichern: ' + (err.message || err), 'error');
        await ladeAlles();
        if (kistenCheckAktuelleId) renderKistenInhaltListe(kistenCheckAktuelleId);
    }
}

async function flushAllPendingArtikelUpdates() {
    for (const bId of Array.from(pendingArtikelUpdates.keys())) {
        if (pendingArtikelUpdates.has(bId)) {
            clearTimeout(pendingArtikelUpdates.get(bId).timer);
            await flushPendingArtikelUpdate(bId);
        }
    }
}

async function frageKisteAusbuchen() {
    if (kisteAktionInArbeit) return;
    await flushAllPendingArtikelUpdates();
    if (!kistenCheckAktuelleId) return;

    const ort = alleLagerorte.find(o => String(o.id) === String(kistenCheckAktuelleId));
    if (!ort) return;
    if (!aktiverKistenBenutzer) { showToast('Bitte wähle zuerst einen Benutzer aus!', 'warning'); return oeffneKistenBenutzerModal(); }
    if (aktiverKistenBenutzer.isHelper) return showToast('Helfer-Account: Ausbuchen ist gesperrt!', 'warning');

    const bestand = gibKistenBestand(kistenCheckAktuelleId);
    if (!bestand.some(z => Number(z.ist_menge) > 0)) return showToast('Kein Material zum Ausbuchen vorhanden.', 'warning');
    if (!confirm(`Ganze Kiste "${ort.name}" an ${aktiverKistenBenutzer.name} ausbuchen?`)) return;

    kisteAktionInArbeit = true;
    try {
        await Promise.all(bestand.filter(z => Number(z.ist_menge) >= 0).map(z => 
            dbClient.from('bestand').update({ menge: 0, alte_menge: z.soll_menge || z.ist_menge, created_at: new Date().toISOString() }).eq('id', z.id)
        ));

        const entnahmePayload = {
            name: aktiverKistenBenutzer.name, kontakt: aktiverKistenBenutzer.kontakt || '',
            benutzer_vorlage_id: aktiverKistenBenutzer.id || null,
            materialien: [{
                kiste_id: Number(kistenCheckAktuelleId), kiste_name: ort.name, ganze_kiste: true,
                artikel: bestand.map(b => ({ bestand_id: b.id, artikel_id: b.artikel_id, name: b.artikel?.name, menge: b.ist_menge > 0 ? b.ist_menge : b.soll_menge, typ: b.artikel?.typ || 'zaehlbar' }))
            }],
            created_at: new Date().toISOString()
        };
        await dbClient.from('lager_entnahmen').insert([entnahmePayload]);
        dbAudit(entnahmePayload, 'entnahme');

        showToast(`📤 "${ort.name}" an ${aktiverKistenBenutzer.name} ausgebucht!`);
        await ladeAlles();
        oeffneKistenCheck(kistenCheckAktuelleId);
    } catch (err) {
        showToast('Fehler beim Ausbuchen: ' + (err.message || err), 'error');
    } finally { kisteAktionInArbeit = false; }
}

async function ganzeKisteZurueckbuchen() {
    if (kisteAktionInArbeit) return;
    await flushAllPendingArtikelUpdates();
    if (!kistenCheckAktuelleId) return;

    const bestand = gibKistenBestand(kistenCheckAktuelleId);
    kisteAktionInArbeit = true;
    try {
        await Promise.all(bestand.filter(z => Number(z.ist_menge) >= 0).map(z => {
            const soll = z.soll_menge > 0 ? z.soll_menge : (z.alte_menge > 0 ? z.alte_menge : z.ist_menge);
            return dbClient.from('bestand').update({ menge: soll, created_at: new Date().toISOString() }).eq('id', z.id);
        }));

        const offene = offeneEntnahmen.filter(e => Array.isArray(e.materialien) && e.materialien.some(m => String(m.kiste_id) === String(kistenCheckAktuelleId)));
        for (const ent of offene) {
            dbAudit({ entnahme_id: ent.id, name: ent.name, kontakt: ent.kontakt, materialien: ent.materialien }, 'rueckgabe');
            await dbClient.from('lager_entnahmen').delete().eq('id', ent.id);
        }

        if (navigator.vibrate) navigator.vibrate(200);
        showToast('✅ Kiste vollständig zurückgebucht!');
        await ladeAlles();
        oeffneKistenCheck(kistenCheckAktuelleId);
    } finally { kisteAktionInArbeit = false; }
}

async function speichereKisteMengeInput(bId, rawVal) {
    if (pendingArtikelUpdates.has(bId)) {
        clearTimeout(pendingArtikelUpdates.get(bId).timer);
        pendingArtikelUpdates.delete(bId);
    }
    const eintrag = aktuelleDaten.find(b => b.id === bId);
    if (!eintrag) return;
    const alterWert = Number(eintrag.ist_menge) || 0, soll = Number(eintrag.soll_menge) || 0;
    let val = Math.max(0, werteMengeAus(rawVal));
    if (soll > 0 && val > soll) { showToast(`Maximal ${soll} möglich!`, 'warning'); val = soll; }

    if (aktiverKistenBenutzer?.isHelper && val < alterWert) {
        showToast('Helfer dürfen Bestände nicht verringern!', 'warning');
        return renderKistenInhaltListe(kistenCheckAktuelleId);
    }

    await dbClient.from('bestand').update({ menge: val, created_at: new Date().toISOString() }).eq('id', bId);
    const diff = val - alterWert;
    if (diff > 0) {
        await reduziereOffeneEntnahmenFuerArtikel(eintrag.lagerort_id, bId, eintrag.artikel_id, eintrag.artikel?.name, diff);
    } else if (diff < 0 && aktiverKistenBenutzer && !aktiverKistenBenutzer.isHelper) {
        const entPayload = {
            name: aktiverKistenBenutzer.name, kontakt: aktiverKistenBenutzer.kontakt || '', benutzer_vorlage_id: aktiverKistenBenutzer.id || null,
            materialien: [{ kiste_id: Number(eintrag.lagerort_id), kiste_name: eintrag.lagerorte?.name || 'Kiste', ganze_kiste: false, artikel: [{ bestand_id: bId, artikel_id: eintrag.artikel_id, name: eintrag.artikel?.name, menge: Math.abs(diff), typ: 'zaehlbar' }] }],
            created_at: new Date().toISOString()
        };
        await dbClient.from('lager_entnahmen').insert([entPayload]);
        dbAudit(entPayload, 'entnahme');
    }
    showToast(`Bestand: ${val} / ${soll}`);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

function toggleKistenEditForm() {
    const el = $('kisten-check-edit-bereich');
    const istS = el.style.display !== 'none';
    el.style.display = istS ? 'none' : 'block';
    $('kiste-edit-toggle-btn').innerText = istS ? '⚙️ Inhalt bearbeiten' : 'Schließen';
}

async function kistenCheckArtikelHinzufuegen() {
    const inp = $('kisten-check-artikel-input');
    const val = inp.value.trim();
    if (!val) return;
    const art = alleArtikelInfos.find(a => a.name.toLowerCase() === val.toLowerCase());
    if (!art) return showToast(`Artikel "${val}" nicht gefunden.`, 'error');

    const sonstigOrt = alleLagerorte.find(o => ['sonstiger lagerort', 'sonstiges'].includes(o.name.trim().toLowerCase()));
    const sonstigEintrag = sonstigOrt ? aktuelleDaten.find(b => b.artikel_id === art.id && String(b.lagerort_id) === String(sonstigOrt.id)) : null;
    const kistenEintrag = aktuelleDaten.find(b => b.artikel_id === art.id && String(b.lagerort_id) === String(kistenCheckAktuelleId));

    const aktuellInKiste = kistenEintrag ? Number(kistenEintrag.soll_menge >= 0 ? kistenEintrag.soll_menge : kistenEintrag.menge) : 0;
    const verfSonstig = sonstigEintrag ? Number(sonstigEintrag.soll_menge >= 0 ? sonstigEintrag.soll_menge : sonstigEintrag.menge) : 0;
    const maxMoeglich = aktuellInKiste + verfSonstig;

    if (maxMoeglich <= 0) return showToast(`Kein Bestand von "${art.name}" bei "Sonstiger Lagerort" vorhanden.`, 'warning');
    const startMenge = prompt(`Menge für "${art.name}" (Max. ${maxMoeglich}):`, String(maxMoeglich));
    if (startMenge === null) return;
    const zielMenge = werteMengeAus(startMenge);
    if (zielMenge <= 0 || zielMenge > maxMoeglich) return showToast(`Ungültige Menge (max. ${maxMoeglich})!`, 'warning');

    const diff = zielMenge - aktuellInKiste;
    const neuerSonstig = verfSonstig - diff;

    if (kistenEintrag) {
        await dbClient.from('bestand').update({ menge: zielMenge, alte_menge: zielMenge, created_at: new Date().toISOString() }).eq('id', kistenEintrag.id);
    } else {
        await dbClient.from('bestand').insert([{ artikel_id: art.id, lagerort_id: Number(kistenCheckAktuelleId), menge: zielMenge, alte_menge: zielMenge, created_at: new Date().toISOString() }]);
    }

    if (sonstigEintrag) {
        if (neuerSonstig <= 0) await dbClient.from('bestand').delete().eq('id', sonstigEintrag.id);
        else await dbClient.from('bestand').update({ menge: neuerSonstig, alte_menge: neuerSonstig, created_at: new Date().toISOString() }).eq('id', sonstigEintrag.id);
    }

    inp.value = '';
    showToast(`✅ Bestände für "${art.name}" aktualisiert.`);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

async function entferneArtikelAusKiste(bestandId) {
    if (!confirm('Artikel aus dieser Kiste entfernen und auf "Sonstiger Lagerort" verschieben?')) return;
    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;

    let sonstigOrt = alleLagerorte.find(o => ['sonstiger lagerort', 'sonstiges'].includes(o.name.trim().toLowerCase()));
    if (!sonstigOrt) {
        const { data } = await dbClient.from('lagerorte').insert([{ name: 'Sonstiger Lagerort' }]).select();
        sonstigOrt = data[0];
        await ladeLagerorte();
    }

    const exSonstig = aktuelleDaten.find(b => b.artikel_id === eintrag.artikel_id && String(b.lagerort_id) === String(sonstigOrt.id) && b.id !== bestandId);
    if (exSonstig) {
        const neueM = (Number(exSonstig.menge) < 0 || Number(eintrag.menge) < 0) ? exSonstig.menge : Number(exSonstig.menge) + Number(eintrag.menge);
        await dbClient.from('bestand').update({ menge: neueM, alte_menge: neueM, created_at: new Date().toISOString() }).eq('id', exSonstig.id);
        await dbClient.from('bestand').delete().eq('id', bestandId);
    } else {
        await dbClient.from('bestand').update({ lagerort_id: sonstigOrt.id, created_at: new Date().toISOString() }).eq('id', bestandId);
    }
    showToast(`Artikel auf "${sonstigOrt.name}" verschoben.`);
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

async function schliesseKistenCheckModal() {
    await flushAllPendingArtikelUpdates();
    closeModal('kistenCheckModal');
    kistenCheckAktuelleId = '';
}

// =========================================================================
// 6. HARDWARE SCANNING (NFC & QR UNIVERSAL-SCAN)
// =========================================================================
async function verarbeiteUniversalScan(rawCode) {
    if (scanSperre.kisten) return;
    scanSperre.kisten = true;
    setTimeout(() => { scanSperre.kisten = false; }, 1500);

    const raw = String(rawCode || '').trim();
    let ortCode = null;
    const mUrl = /kistencheck=([^&\s]+)/i.exec(raw), mPref = /^(?:ort|behaelter):(.+)$/i.exec(raw);
    if (mUrl) ortCode = decodeURIComponent(mUrl[1]);
    else if (mPref) ortCode = mPref[1].trim();
    else ortCode = raw;

    // 1. Direkte Treffer: Entweder über hinterlegten nfc_code oder direkt über die ID
    let ort = alleLagerorte.find(o => 
        (o.nfc_code && String(o.nfc_code).toLowerCase() === ortCode.toLowerCase()) ||
        String(o.id) === ortCode
    );

    // 2. Abwärtskompatibilität: Falls ein altes Etikett (z.B. "kiste-ausschank-42" oder "kiste-42") gescannt wird
    if (!ort) {
        const mId = ortCode.match(/(?:^kiste-.*-|^kiste-)?(\d+)$/i);
        if (mId) {
            const parsedId = mId[1];
            ort = alleLagerorte.find(o => String(o.id) === parsedId);
        }
    }

    if (ort) {
        if (navigator.vibrate) navigator.vibrate(120);
        return oeffneKistenCheck(ort.id);
    }
    showToast(`Code "${raw}" wurde nicht erkannt.`, 'error');
}

async function starteKistenNfc() {
    if (aktiverNfcModus === 'kisten') { deaktiviereNfc(); return showToast('NFC beendet.'); }
    if (!('NDEFReader' in window) && typeof window.nfc === 'undefined') return showToast('Web-NFC wird nicht unterstützt.', 'error');

    aktiverNfcModus = 'kisten';
    const btn = $('tab-nfc-btn');
    if (btn) { btn.classList.add('nfc-aktiv'); btn.innerText = '📶 NFC aktiv (Stopp)'; }

    if (typeof window.nfc !== 'undefined') {
        window.nfc.addNdefListener(evt => {
            try { const txt = window.nfc.bytesToString(evt.tag?.ndefMessage?.[0]?.payload); if (txt) verarbeiteUniversalScan(txt); } catch {}
        });
        return showToast('📶 NFC aktiv: Kiste ans Handy halten.');
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
    const btn = $('tab-nfc-btn');
    if (btn) { btn.classList.remove('nfc-aktiv'); btn.innerText = '📶 NFC-Scan'; }
}

async function holeOderErzeugeOrtCode(ort) {
    if (!ort) return null;
    const code = String(ort.id);
    
    // Falls noch kein Code oder noch der alte Namens-Slug in der DB steht, auf reine ID aktualisieren
    if (String(ort.nfc_code || '') !== code) {
        const { error } = await dbClient.from('lagerorte').update({ nfc_code: code }).eq('id', ort.id);
        if (!error) {
            ort.nfc_code = code;
        } else {
            console.error('Fehler beim Speichern des Kisten-Codes:', error);
        }
    }
    return code;
}

async function schreibeNfcTagFuerOrt() {
    const oId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(oId));
    if (!ort) return showToast('Bitte zuerst Lagerort auswählen.', 'warning');
    const code = await holeOderErzeugeOrtCode(ort);
    ortSelectChanged();

    if (!('NDEFReader' in window)) return showToast('NFC-Schreiben nicht unterstützt.', 'error');
    try {
        const writer = new NDEFReader();
        showToast('📶 Leeren Tag an das Handy halten…');
        await writer.write({ records: [{ recordType: 'url', data: `https://trilager.pius-s.de?kistencheck=${encodeURIComponent(code)}` }] });
        if (navigator.vibrate) navigator.vibrate(200);
        showToast(`✅ Tag für "${ort.name}" beschrieben!`);
    } catch (err) { showToast('Fehler: ' + err.message, 'error'); }
}

function oeffneKistenKameraModal() {
    const wrap = $('hub-camera-wrapper'), status = $('hub-scanner-status'), btnText = $('hub-kamera-text');
    if (wrap.style.display === 'block') return stoppeHubKamera();

    wrap.style.display = 'block';
    status.style.display = 'block';
    status.innerText = 'Kamera startet…';
    if (btnText) btnText.innerText = '✕ Kamera stoppen';

    if (aktiverQrScanner) { try { aktiverQrScanner.stop(); aktiverQrScanner.clear(); } catch {} }
    aktiverQrScanner = new Html5Qrcode('hub-qr-reader');
    aktiverQrScanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } }, (decoded) => {
        stoppeHubKamera();
        verarbeiteUniversalScan(decoded);
    }, () => {}).then(() => { status.innerText = 'Bereit – QR-Code vor die Kamera halten.'; })
    .catch(err => { showToast('Kamera-Fehler: ' + err.message, 'error'); stoppeHubKamera(); });
}

function stoppeHubKamera() {
    if (aktiverQrScanner) { aktiverQrScanner.stop().then(() => aktiverQrScanner.clear()).catch(() => {}).finally(() => { aktiverQrScanner = null; }); }
    const wrap = $('hub-camera-wrapper'), status = $('hub-scanner-status'), btnText = $('hub-kamera-text');
    if (wrap) wrap.style.display = 'none';
    if (status) status.style.display = 'none';
    if (btnText) btnText.innerText = 'Kamera-Scan';
}

// =========================================================================
// 7. LAGER-MODUS (TABELLE & FILTER)
// =========================================================================
function wendeFilterAn() {
    const katFilter = $('kategorie-filter')?.value || 'ALLE';
    const comboFilter = $('ort-filter-combo')?.value || '';
    const suchText = $('such-filter')?.value.toLowerCase().trim() || '';

    let ortFilter = 'ALLE', regalTemp = '';
    if (comboFilter.startsWith('ort:')) ortFilter = comboFilter.substring(4);
    else if (comboFilter.startsWith('regal:')) regalTemp = comboFilter.substring(6);
    aktiverRegalFilter = regalTemp || (comboFilter === '' ? '' : aktiverRegalFilter);

    const gefiltert = aktuelleDaten.filter(z => {
        if (suchText && ![z.artikel?.name, z.artikel?.kategorie, z.lagerorte?.name, String(z.artikel?.id ?? '')].some(f => (f || '').toLowerCase().includes(suchText))) return false;
        if (aktiverRegalFilter && ![z.artikel?.name, z.artikel?.kategorie, z.lagerorte?.name].some(t => textEnthaeltRegal(t, aktiverRegalFilter))) return false;
        if (katFilter !== 'ALLE' && z.artikel?.kategorie !== katFilter) return false;
        if (ortFilter !== 'ALLE' && String(z.lagerort_id) !== String(ortFilter)) return false;
        return true;
    });
    tabelleAktualisieren(gefiltert);
}

function ortComboChanged() {
    const val = $('ort-filter-combo')?.value || '';
    aktiverRegalFilter = val.startsWith('regal:') ? val.substring(6) : '';
    wendeFilterAn();
}

function toggleSortierung() {
    sortAscending = !sortAscending;
    $('btn-sort').innerText = sortAscending ? 'A-Z' : 'Z-A';
    wendeFilterAn();
}
function toggleGruppe(name) { offeneGruppen.has(name) ? offeneGruppen.delete(name) : offeneGruppen.add(name); wendeFilterAn(); }
function toggleAlleGruppen() {
    isAllOpen = !isAllOpen;
    offeneGruppen.clear();
    if (isAllOpen) aktuelleDaten.forEach(z => { if (z.artikel) offeneGruppen.add(z.artikel.kategorie || 'Ohne Kategorie'); });
    wendeFilterAn();
}
function toggleAlleArtikelSichtbarkeit() { zeigeAlleArtikel = !zeigeAlleArtikel; wendeFilterAn(); }

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
        resMap[p.artikel_id].listen[pl ? pl.name : 'Unbekannt'] = (resMap[p.artikel_id].listen[pl ? pl.name : 'Unbekannt'] || 0) + Number(p.menge);
    });

    const anzeigeDaten = (zeigeAlleArtikel || isSearching) ? daten : daten.filter(z => z.artikel?.wichtig);
    const gruppen = {};
    anzeigeDaten.forEach(z => {
        if (!z.artikel) return;
        const kat = z.artikel.kategorie || 'Ohne Kategorie';
        (gruppen[kat] = gruppen[kat] || []).push(z);
    });

    const sortFactor = sortAscending ? 1 : -1;
    const sortedKategorien = Object.keys(gruppen).sort((a, b) => {
        if (a === 'Ohne Kategorie') return 1; if (b === 'Ohne Kategorie') return -1;
        return a.localeCompare(b, 'de') * sortFactor;
    });

    if (!anzeigeDaten.length) {
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

        const headerTr = document.createElement('tr');
        headerTr.style.cursor = 'pointer';
        headerTr.onclick = () => toggleGruppe(katName);
        headerTr.innerHTML = `
            <td colspan="3" style="background-color:#e2e8f0; color:#2c3e50; font-weight:bold; padding:12px; user-select:none;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>${isOpen ? '📂' : '📁'} ${escapeHtml(katName)}</span>
                    <span class="summen-badge">Gesamt: ${hatUnendlich ? (ordnerSumme > 0 ? `${ordnerSumme} + ∞` : '∞') : ordnerSumme}</span>
                </div>
            </td>`;
        tbody.appendChild(headerTr);
        if (!isOpen) return;

        const artMap = new Map();
        zeilen.forEach(z => {
            if (!artMap.has(z.artikel_id)) artMap.set(z.artikel_id, { artikel: z.artikel, bestaende: [] });
            artMap.get(z.artikel_id).bestaende.push(z);
        });

        const prefixArtikelSets = {}, prefixSums = {}, prefixInf = {};
        artMap.forEach(grp => {
            const parts = grp.artikel.name.trim().split(' ');
            if (parts.length > 1) {
                const pref = parts[0];
                (prefixArtikelSets[pref] = prefixArtikelSets[pref] || new Set()).add(grp.artikel.id);
                grp.bestaende.forEach(b => {
                    if (Number(b.menge) === -1) prefixInf[pref] = true;
                    else if (Number(b.menge) >= 0) prefixSums[pref] = (prefixSums[pref] || 0) + Number(b.soll_menge >= 0 ? b.soll_menge : b.menge);
                });
            }
        });

        const sortierteArtikel = Array.from(artMap.entries()).map(([artId, grp]) => ({
            artId, grp, sortRegal: ermittleRegalSchluessel(grp.bestaende), sortName: grp.artikel.name.trim()
        })).sort((a, b) => vergleicheRegalNamen(a.sortRegal, b.sortRegal, sortFactor) || a.sortName.localeCompare(b.sortName, 'de', { numeric: true }) * sortFactor);

        let currentPrefix = null;
        sortierteArtikel.forEach(({ grp, artId }) => {
            grp.bestaende.sort((a, b) => vergleicheRegalNamen(a.lagerorte?.name || '', b.lagerorte?.name || '', sortFactor));
            const parts = grp.artikel.name.trim().split(' ');
            const hatMehrere = parts.length > 1 && prefixArtikelSets[parts[0]]?.size > 1;
            const pref = hatMehrere ? parts[0] : null;

            if (hatMehrere && currentPrefix !== pref) {
                const pSum = prefixSums[pref] || 0, pInf = prefixInf[pref];
                const subTr = document.createElement('tr');
                subTr.innerHTML = `
                    <td colspan="3" style="padding-left:25px; background:#fafafa; color:#7f8c8d; font-size:0.85em; font-weight:bold; border-bottom:1px dashed #ddd; user-select:none;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span>🏷️ ${escapeHtml(pref)}</span>
                            <span class="sub-sum-badge">Gesamt: ${pInf ? (pSum > 0 ? `${pSum} + ∞` : '∞') : pSum}</span>
                        </div>
                    </td>`;
                tbody.appendChild(subTr);
                currentPrefix = pref;
            } else if (!hatMehrere) { currentPrefix = null; }

            const tr = document.createElement('tr');
            tr.style.cursor = isEditMode ? 'pointer' : 'default';
            tr.onclick = (e) => { if (!['INPUT', 'BUTTON', 'SVG', 'PATH'].includes(e.target.tagName)) openEditModal(artId); };

            const displayName = hatMehrere ? grp.artikel.name.trim().substring(pref.length).trim() : grp.artikel.name;
            const wichtigBadge = grp.artikel.wichtig ? '<span class="badge-markiert">MARKIERT</span>' : '';
            const hatKommentar = Boolean(grp.artikel.kommentar?.trim());
            const kommentarIcon = isEditMode ? `
                <span onclick="openKommentarModal('${artId}', event)" style="cursor:pointer; margin-left:8px; vertical-align:middle; opacity:${hatKommentar ? '1' : '0.5'};" title="Notiz bearbeiten">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="${hatKommentar ? '#3498db' : 'none'}" stroke="${hatKommentar ? '#3498db' : '#bdc3c7'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                </span>` : '';
            const kommentarAnzeige = !isEditMode && hatKommentar ? `<div class="bestand-kommentar-anzeige"><span style="color:#3498db;">💬</span><span style="word-break:break-word;">${escapeHtml(grp.artikel.kommentar.trim())}</span></div>` : '';

            const res = resMap[artId];
            const resHtml = res?.gesamt > 0 ? `<div class="bestand-reserviert-info" data-hover-type="res" data-hover-content="${escapeHtml('<strong>Reserviert für:</strong><br>' + Object.entries(res.listen).map(([l, m]) => `• ${m}x in <i>${escapeHtml(l)}</i><br>`).join(''))}" onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)">📦 Reserviert: ${res.gesamt}</div>` : '';

            const einheit = grp.artikel.einheit || 'Stück';
            const bestandRowsHtml = grp.bestaende.map(b => {
                const m = Number(b.menge), soll = Number(b.soll_menge), ist = Number(b.ist_menge);
                const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
                let zelle = '';
                if (m === -1) zelle = `<span style="font-size:1.2em; color:#7f8c8d; font-weight:bold;">∞</span> <small class="bestand-einheit">${einheit}</small>`;
                else if (m === -2 || m === -3) zelle = `<span class="bestand-status-pill ${m === -3 ? 'warn' : 'ok'}">-</span>`;
                else {
                    zelle = `
                        <div style="display:flex; flex-direction:column; align-items:flex-end;">
                            <div class="bestand-ort-qty-wrap">
                                <input type="text" id="menge-${b.id}" class="menge-input bestand-menge-input ${soll > 0 ? 'bestand-menge-ok' : 'bestand-menge-low'}" value="${soll}" onchange="speichereMenge(${b.id})" oninput="aktualisiereMengeEingabeFarbe(this)" style="width:60px;" title="Gesamtbestand">
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
                <td style="padding-left:${hatMehrere ? 45 : 25}px;" data-hover-type="date" data-hover-content="${dateStr}" onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)">
                    ${hatMehrere ? '◦' : '↳'} <strong>${escapeHtml(displayName)}</strong>${wichtigBadge}${kommentarIcon}${kommentarAnzeige}
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
        footTr.innerHTML = `<td colspan="3" style="padding:14px; text-align:center; background:#f8fafc; border-top:1px solid #dfe6e9;"><button class="btn" onclick="toggleAlleArtikelSichtbarkeit()" style="background:#34495e; width:auto; min-width:220px;">${zeigeAlleArtikel ? 'Weniger anzeigen' : `Mehr anzeigen (${hiddenCount} weitere)`}</button></td>`;
        tbody.appendChild(footTr);
    }
}

async function speichereMenge(bId) {
    const f = $(`menge-${bId}`);
    if (!f) return;
    const val = f.value.trim();
    const neueMenge = val === '∞' ? -1 : (val === '-' ? BESTAND_STRICH_AUSREICHEND : werteMengeAus(val));
    f.value = neueMenge === -1 ? '∞' : (neueMenge < 0 ? '-' : neueMenge);
    aktualisiereMengeEingabeFarbe(f);
    f.style.backgroundColor = '#fff3cd';

    const eintrag = aktuelleDaten.find(b => b.id === bId);
    const altesSoll = Number(eintrag?.soll_menge) || 0, altesIst = Number(eintrag?.ist_menge) || 0;
    const neuesIst = neueMenge >= 0 ? Math.max(0, Math.min(neueMenge, (altesIst >= 0 ? altesIst : neueMenge) + (neueMenge - altesSoll))) : neueMenge;

    const { error } = await dbClient.from('bestand').update({ menge: neueMenge < 0 ? neueMenge : neuesIst, alte_menge: neueMenge, created_at: new Date().toISOString() }).eq('id', bId);
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
// 8. KISTEN-ANSICHT, OFFENE ENTNAHMEN, ARTIKELSUCHE & AUDIT-LOG
// =========================================================================
function kistenFilterSucheGeaendert() {
    if (kistenAnsichtFilter === 'log') renderAuditLogListe();
    else if (kistenAnsichtFilter === 'unterwegs_wer') renderKistenUnterwegsKombiniert();
    else if (kistenAnsichtFilter === 'artikelsuche') renderKistenArtikelSuche();
    else renderKistenListe();
}

function setzeKistenAnsichtFilter(filterName) {
    kistenAnsichtFilter = filterName || 'alle';
    ['alle', 'artikelsuche', 'unterwegs_wer', 'log'].forEach(f => $(`filter-kisten-${f.replace('_', '-')}`)?.classList.toggle('active', f === kistenAnsichtFilter));

    if ($('kisten-tabelle-bereich')) $('kisten-tabelle-bereich').style.display = (kistenAnsichtFilter === 'alle') ? 'block' : 'none';
    if ($('kisten-artikelsuche-bereich')) $('kisten-artikelsuche-bereich').style.display = (kistenAnsichtFilter === 'artikelsuche') ? 'block' : 'none';
    if ($('kisten-unterwegs-kombiniert-bereich')) $('kisten-unterwegs-kombiniert-bereich').style.display = (kistenAnsichtFilter === 'unterwegs_wer') ? 'block' : 'none';
    if ($('audit-log-bereich')) $('audit-log-bereich').style.display = (kistenAnsichtFilter === 'log') ? 'block' : 'none';

    if (kistenAnsichtFilter === 'unterwegs_wer') { renderKistenUnterwegsKombiniert(); starteUnterwegsAutoRefresh(); }
    else if (kistenAnsichtFilter === 'artikelsuche') { stoppeUnterwegsAutoRefresh(); renderKistenArtikelSuche(); }
    else if (kistenAnsichtFilter === 'log') { stoppeUnterwegsAutoRefresh(); renderAuditLogListe(); }
    else { stoppeUnterwegsAutoRefresh(); renderKistenListe(); }
}

function starteUnterwegsAutoRefresh() {
    stoppeUnterwegsAutoRefresh();
    unterwegsRefreshInterval = setInterval(async () => {
        if (aktuellerModus === 'kisten' && kistenAnsichtFilter === 'unterwegs_wer') {
            const el = document.activeElement;
            if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) {
                await Promise.all([ladeBestand(), ladeEntnahmeDaten()]);
                renderKistenUnterwegsKombiniert();
            }
        }
    }, 15000);
}

function stoppeUnterwegsAutoRefresh() {
    if (unterwegsRefreshInterval) { clearInterval(unterwegsRefreshInterval); unterwegsRefreshInterval = null; }
}

async function manuelleAktualisierungUnterwegs() {
    showToast('Aktualisiere Entnahmen...');
    await Promise.all([ladeBestand(), ladeEntnahmeDaten()]);
    renderKistenUnterwegsKombiniert();
}

function renderKistenListe() {
    const ziel = $('kisten-tabelle');
    if (!ziel) return;
    const suchText = ($('kisten-such-filter')?.value || '').toLowerCase().trim();
    const liste = alleLagerorte.filter(o => !suchText || o.name.toLowerCase().includes(suchText) || (o.nfc_code || '').toLowerCase().includes(suchText));

    if (!liste.length) { ziel.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Keine passenden Kisten gefunden.</td></tr>'; return; }

    const standardKisten = [], nurUnendlicheKisten = [];
    liste.forEach(o => {
        const bestand = gibKistenBestand(o.id);
        const hatNurUnendlich = bestand.length > 0 && bestand.every(b => Number(b.ist_menge) === -1 || Number(b.menge) === -1);
        if (hatNurUnendlich) nurUnendlicheKisten.push({ o, bestand });
        else standardKisten.push({ o, bestand });
    });

    const renderRow = (o, bestand) => `
        <tr>
            <td><strong>${escapeHtml(o.name)}</strong><br><small style="color:#7f8c8d;">${escapeHtml(o.nfc_code || 'Kein Code')}</small></td>
            <td>${bestand.length} Artikel</td>
            <td>${ermittleKistenStatusCell(o.id, bestand)}</td>
            <td>
                <button class="btn" style="background:#16a085; padding:8px 12px; width:auto;" onclick="oeffneKistenCheck(${o.id})">📦 Inhalt / Prüfen</button>
                <button class="btn" style="background:#3498db; padding:8px 12px; width:auto;" onclick="openOrteVerwalten(${o.id})">⚙️</button>
            </td>
        </tr>`;

    let html = standardKisten.map(i => renderRow(i.o, i.bestand)).join('');

    if (nurUnendlicheKisten.length > 0) {
        const isOffen = kistenNurUnendlichOffen || Boolean(suchText);
        html += `
            <tr style="background:#e2e8f0; cursor:pointer;" onclick="toggleKistenNurUnendlich()">
                <td colspan="4" style="padding:10px 14px; font-weight:bold; color:#334155; user-select:none;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span>${isOffen ? '▼' : '▶'} Kisten mit nur unbegrenzten Artikeln (${nurUnendlicheKisten.length})</span>
                        <small style="color:#64748b; font-weight:normal;">${isOffen ? 'Einklappen' : 'Ausklappen'}</small>
                    </div>
                </td>
            </tr>`;
        if (isOffen) html += nurUnendlicheKisten.map(i => renderRow(i.o, i.bestand)).join('');
    }

    ziel.innerHTML = html;
}

function toggleKistenNurUnendlich() {
    kistenNurUnendlichOffen = !kistenNurUnendlichOffen;
    renderKistenListe();
}

// -------------------------------------------------------------------------
// ARTIKELSUCHE IM REITER KISTEN & VERLEIH
// -------------------------------------------------------------------------
function waehleArtikelFuerKistenSuche(artId) {
    kistenArtikelSucheAuswahlId = Number(artId);
    renderKistenArtikelSuche();
}

function renderKistenArtikelSuche() {
    const ziel = $('kisten-artikelsuche-bereich');
    if (!ziel) return;

    const suchText = ($('kisten-such-filter')?.value || '').toLowerCase().trim();
    let treffer = alleArtikelInfos;
    if (suchText) {
        treffer = alleArtikelInfos.filter(a => (a.name || '').toLowerCase().includes(suchText) || (a.kategorie || '').toLowerCase().includes(suchText));
    }

    // Wenn aktuell ausgewählter Artikel nicht in Treffern und Suche aktiv ist
    let ausgewaehlterArtikel = null;
    if (kistenArtikelSucheAuswahlId) {
        ausgewaehlterArtikel = alleArtikelInfos.find(a => a.id === kistenArtikelSucheAuswahlId);
    } else if (treffer.length === 1) {
        ausgewaehlterArtikel = treffer[0];
        kistenArtikelSucheAuswahlId = ausgewaehlterArtikel.id;
    }

    let html = `
        <div style="background:#f8fafc; border:1px solid #d9e3ec; border-radius:10px; padding:14px; margin-bottom:16px;">
            <div style="font-weight:bold; color:#2c3e50; margin-bottom:8px; font-size:1em;">
                🔎 Wähle einen Artikel aus (Ergebnisse: ${treffer.length}${suchText ? ` für "${escapeHtml(suchText)}"` : ''}):
            </div>
            <div style="max-height: 160px; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 6px;">
                ${treffer.slice(0, 40).map(a => {
                    const istGewaehlt = ausgewaehlterArtikel && ausgewaehlterArtikel.id === a.id;
                    return `
                        <button type="button" class="btn" style="background:${istGewaehlt ? '#e3000f' : '#fff'}; color:${istGewaehlt ? '#fff' : '#2c3e50'}; border:1px solid ${istGewaehlt ? '#c40010' : '#cbd5e1'}; padding:6px 12px; font-size:0.88em; width:auto; min-height:34px; box-shadow:none;" onclick="waehleArtikelFuerKistenSuche(${a.id})">
                            ${escapeHtml(a.name)}
                        </button>
                    `;
                }).join('') || '<span style="color:#7f8c8d; padding:4px;">Keine passenden Artikel gefunden.</span>'}
            </div>
        </div>
    `;

    if (!ausgewaehlterArtikel) {
        html += `
            <div style="text-align:center; padding:30px 15px; color:#64748b; background:#fff; border:1px dashed #cbd5e1; border-radius:10px;">
                👆 Klicke oben auf einen Artikel oder tippe einen Namen in das Suchfeld ein, um seinen Kisten-Standort und Ausleih-Status zu sehen.
            </div>
        `;
        ziel.innerHTML = html;
        return;
    }

    const artId = ausgewaehlterArtikel.id;
    const bestaende = aktuelleDaten.filter(b => b.artikel_id === artId);
    const einheit = ausgewaehlterArtikel.einheit || 'Stück';

    // 1. Kisten / Lagerorte
    let orteHtml = '';
    if (!bestaende.length) {
        orteHtml = '<p style="color:#7f8c8d; margin:6px 0;">Dieser Artikel ist derzeit keinem Lagerort bzw. keiner Kiste zugeordnet.</p>';
    } else {
        orteHtml = `
            <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
                ${bestaende.map(b => {
                    const ist = Number(b.ist_menge), soll = Number(b.soll_menge);
                    const istUnendlich = (ist === -1);
                    let qtyStr = istUnendlich ? '∞ (Unbegrenzt)' : `${ist} von max. ${soll} ${einheit} im Lager`;
                    const fehlt = (soll > 0 && ist >= 0) ? Math.max(0, soll - ist) : 0;
                    return `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#fff; border:1px solid #e2e8f0; border-radius:8px; gap:8px;">
                            <div>
                                <strong style="font-size:1.02em; color:#2c3e50;">📦 ${escapeHtml(b.lagerorte?.name || 'Kiste')}</strong>
                                <div style="font-size:0.85em; color:#555; margin-top:2px;">
                                    ${qtyStr} ${fehlt > 0 ? `&bull; <span style="color:#c0392b; font-weight:bold;">${fehlt} fehlen</span>` : ''}
                                </div>
                            </div>
                            <button class="btn" style="background:#16a085; padding:6px 12px; font-size:0.85em; width:auto; min-height:34px;" onclick="oeffneKistenCheck(${b.lagerort_id})">
                                📦 Kiste öffnen
                            </button>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    // 2. Offene Entnahmen für diesen Artikel
    const offeneFuerArtikel = [];
    offeneEntnahmen.forEach(ent => {
        const mats = Array.isArray(ent.materialien) ? ent.materialien : [];
        mats.forEach(m => {
            if (Array.isArray(m.artikel)) {
                m.artikel.forEach(a => {
                    if (matchesArtikel(a, { artikelId: artId, name: ausgewaehlterArtikel.name })) {
                        offeneFuerArtikel.push({
                            entnahmeId: ent.id,
                            name: ent.name,
                            kontakt: ent.kontakt,
                            datum: new Date(ent.created_at),
                            kisteId: m.kiste_id,
                            kisteName: m.kiste_name || 'Kiste',
                            bestandId: a.bestand_id,
                            menge: Number(a.menge) || 1
                        });
                    }
                });
            } else if (m.ganze_kiste && m.kiste_id) {
                // Prüfe, ob dieser Artikel in dieser ganzen Kiste liegt
                const inBox = (gibKistenBestand(m.kiste_id) || []).some(b => b.artikel_id === artId);
                if (inBox) {
                    offeneFuerArtikel.push({
                        entnahmeId: ent.id,
                        name: ent.name,
                        kontakt: ent.kontakt,
                        datum: new Date(ent.created_at),
                        kisteId: m.kiste_id,
                        kisteName: m.kiste_name || 'Kiste',
                        bestandId: null,
                        menge: 1,
                        isGanzeKiste: true
                    });
                }
            }
        });
    });

    let ausleiheHtml = '';
    if (!offeneFuerArtikel.length) {
        ausleiheHtml = `
            <div style="background:#edf8f0; border:1px solid #8fd0a3; padding:12px 14px; border-radius:8px; margin-top:8px;">
                <span style="color:#1f7a37; font-weight:bold;">✔️ Aktuell nicht ausgeliehen</span>
                <span style="font-size:0.88em; color:#555; margin-left:6px;">(Alle Kistenbestände sind vollzählig im Lager).</span>
            </div>
        `;
    } else {
        ausleiheHtml = `
            <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
                ${offeneFuerArtikel.map(item => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#fff1f0; border:1px solid #fca5a5; border-radius:8px; gap:8px; flex-wrap:wrap;">
                        <div>
                            <strong style="color:#991b1b; font-size:1.02em;">👤 ${escapeHtml(item.name)}</strong>
                            <span style="font-weight:bold; color:#111; margin-left:6px;">hat ${item.menge}x ${escapeHtml(ausgewaehlterArtikel.name)}</span>
                            <div style="font-size:0.82em; color:#666; margin-top:2px;">
                                aus 📦 ${escapeHtml(item.kisteName)} &bull; 📅 Entnommen: ${item.datum.toLocaleString('de-DE')} ${item.kontakt ? `&bull; 📞 ${escapeHtml(item.kontakt)}` : ''}
                            </div>
                        </div>
                        <button type="button" class="btn btn-save" style="background:#27ae60; padding:6px 14px; font-size:0.85em; width:auto; min-height:36px;" onclick="artikelAusSucheZurueckbuchen('${item.entnahmeId}', ${item.kisteId || 'null'}, ${item.bestandId || 'null'}, ${artId}, '${escapeHtml(ausgewaehlterArtikel.name).replace(/'/g, "\\'")}', ${item.menge})">
                            📥 Jetzt zurückbuchen (${item.menge}x)
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
    }

    html += `
        <div style="background:#fff; border:1px solid #cbd5e1; border-radius:10px; padding:18px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px solid #e2e8f0; padding-bottom:12px; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
                <div>
                    <h2 style="margin:0; color:#2c3e50; font-size:1.35em;">📦 ${escapeHtml(ausgewaehlterArtikel.name)}</h2>
                    <div style="font-size:0.85em; color:#64748b; margin-top:3px;">
                        Kategorie: <strong>${escapeHtml(ausgewaehlterArtikel.kategorie || 'Ohne Kategorie')}</strong> &bull; Einheit: <strong>${escapeHtml(einheit)}</strong> &bull; Typ: <strong>${escapeHtml(ausgewaehlterArtikel.typ || 'zaehlbar')}</strong>
                    </div>
                </div>
                <span class="summen-badge" style="background:#34495e;">ID: ${formatArtikelId(ausgewaehlterArtikel.id)}</span>
            </div>

            <div style="margin-bottom:18px;">
                <strong style="color:#2c3e50; font-size:1.05em;">📍 Zugeordnete Kisten &amp; Lagerorte:</strong>
                ${orteHtml}
            </div>

            <div>
                <strong style="color:#2c3e50; font-size:1.05em;">📤 Ausleih- &amp; Unterwegs-Status:</strong>
                ${ausleiheHtml}
            </div>
        </div>
    `;

    ziel.innerHTML = html;
}

async function artikelAusSucheZurueckbuchen(entnahmeId, kisteId, bestandId, artikelId, artikelName, menge) {
    if (kisteAktionInArbeit) return;
    if (!confirm(`Soll ${menge}x "${artikelName}" wieder zurück in das Lager gebucht werden?`)) return;

    kisteAktionInArbeit = true;
    try {
        // 1. Bestand in der Kiste erhöhen
        let b = null;
        if (bestandId) b = aktuelleDaten.find(x => x.id === Number(bestandId));
        else if (kisteId && artikelId) b = aktuelleDaten.find(x => x.artikel_id === Number(artikelId) && Number(x.lagerort_id) === Number(kisteId));

        if (b && Number(b.menge) >= 0) {
            const aktuell = Number(b.ist_menge) >= 0 ? Number(b.ist_menge) : 0;
            const soll = Number(b.soll_menge) || 0;
            const neu = soll > 0 ? Math.min(soll, aktuell + menge) : aktuell + menge;
            await dbClient.from('bestand').update({ menge: neu, created_at: new Date().toISOString() }).eq('id', b.id);
        }

        // 2. Aus Entnahme abbuchen
        const ent = offeneEntnahmen.find(e => String(e.id) === String(entnahmeId));
        if (ent) {
            let verbleibend = menge;
            (ent.materialien || []).forEach(m => {
                if (verbleibend <= 0 || (kisteId && Number(m.kiste_id) !== Number(kisteId))) return;
                if (Array.isArray(m.artikel)) {
                    m.artikel.forEach(a => {
                        if (verbleibend <= 0) return;
                        if (matchesArtikel(a, { bestandId, artikelId, name: artikelName })) {
                            const abzug = Math.min(verbleibend, a.menge);
                            a.menge -= abzug;
                            verbleibend -= abzug;
                        }
                    });
                    m.artikel = m.artikel.filter(a => a.menge > 0);
                } else if (m.ganze_kiste) {
                    m.ganze_kiste = false;
                }
            });
            await syncEntnahme(ent.id, ent.materialien);

            dbAudit({
                name: ent.name,
                kontakt: ent.kontakt,
                benutzer_vorlage_id: ent.benutzer_vorlage_id,
                materialien: [{
                    kiste_id: kisteId || null,
                    kiste_name: b?.lagerorte?.name || 'Kiste',
                    artikel: [{ bestand_id: bestandId, artikel_id: artikelId, name: artikelName, menge }]
                }]
            }, 'teilrueckgabe');
        }

        showToast(`✅ ${menge}x "${artikelName}" zurückgebucht!`);
        await ladeAlles();
        renderKistenArtikelSuche();
    } catch (err) {
        showToast('Fehler beim Zurückbuchen: ' + (err.message || err), 'error');
    } finally {
        kisteAktionInArbeit = false;
    }
}

// -------------------------------------------------------------------------
// UNTERWEGS: ZUSAMMENFASSUNG NACH BENUTZER & TEILRÜCKGABE
// -------------------------------------------------------------------------
function renderKistenUnterwegsKombiniert() {
    const ziel = $('kisten-unterwegs-kombiniert-bereich');
    if (!ziel) return;

    const suchText = ($('kisten-such-filter')?.value || '').toLowerCase().trim();

    const offeneGefiltert = offeneEntnahmen.filter(e => {
        if (!suchText) return true;
        const nMatch = (e.name || '').toLowerCase().includes(suchText);
        const mats = Array.isArray(e.materialien) ? e.materialien : [];
        return nMatch || mats.some(m => (m.kiste_name || '').toLowerCase().includes(suchText) || (Array.isArray(m.artikel) && m.artikel.some(a => (a.name || '').toLowerCase().includes(suchText))) || (m.name || m.label || '').toLowerCase().includes(suchText));
    });

    const userMap = new Map();
    offeneGefiltert.forEach(ent => {
        const userKey = ent.benutzer_vorlage_id ? String(ent.benutzer_vorlage_id) : (ent.name || 'unbekannt').trim().toLowerCase();
        if (!userMap.has(userKey)) userMap.set(userKey, { userKey, name: ent.name || 'Unbekannt', kontakt: ent.kontakt || '', neuestesDatum: new Date(ent.created_at), entnahmen: [] });
        const u = userMap.get(userKey);
        if (new Date(ent.created_at) > u.neuestesDatum) u.neuestesDatum = new Date(ent.created_at);
        u.entnahmen.push(ent);
    });

    const kistenGefiltert = alleLagerorte.filter(o => {
        if (suchText && !o.name.toLowerCase().includes(suchText) && !(o.nfc_code || '').toLowerCase().includes(suchText)) return false;
        const bestand = gibKistenBestand(o.id), entnahmen = ermittleAlleKistenEntnahmen(o.id);
        return Boolean(entnahmen.length || bestand.some(b => Number(b.soll_menge) > 0 && Number(b.ist_menge) < Number(b.soll_menge)));
    });

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
            <div class="kombiniert-subtitel" style="margin:0;">👤 Aktive Entleiher &amp; Resortleiter (${userMap.size})</div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:0.8em; color:#27ae60; font-weight:bold;">● Live-Aktualisierung (15s)</span>
                <button type="button" class="btn" style="background:#34495e; padding:4px 10px; font-size:0.8em; width:auto; min-height:30px;" onclick="manuelleAktualisierungUnterwegs()">🔄 Jetzt aktualisieren</button>
            </div>
        </div>`;

    if (!userMap.size) {
        html += `<div style="background:#edf8f0; border:1px solid #8fd0a3; padding:16px; border-radius:10px; margin-bottom:18px;"><p style="margin:0; color:#1f7a37; font-weight:bold;">🎉 Aktuell keine offenen Personen-Entnahmen vermerkt.</p></div>`;
    } else {
        userMap.forEach(u => {
            const artikelMap = new Map();
            u.entnahmen.forEach(ent => {
                extrahiereEntnahmePositionen(ent).forEach(pos => {
                    const k = `${pos.kisteId || 'null'}_${pos.bestandId || pos.artikelId || pos.name}`;
                    if (!artikelMap.has(k)) artikelMap.set(k, { name: pos.name, kisteName: pos.kisteName, ganzeKiste: pos.ganzeKiste, menge: 0 });
                    artikelMap.get(k).menge += pos.menge;
                });
            });

            const itemsHtml = Array.from(artikelMap.values()).map(item => item.ganzeKiste 
                ? `<li><strong>📦 ${escapeHtml(item.kisteName || 'Kiste')}</strong> (Kiste komplett entnommen)</li>`
                : `<li><strong>${item.menge}x</strong> ${escapeHtml(item.name)} <span style="color:#7f8c8d; font-size:0.88em;">(aus 📦 ${escapeHtml(item.kisteName || 'Kiste')})</span></li>`
            ).join('');

            html += `
                <div class="entnahme-card">
                    <div class="entnahme-card-header">
                        <div>
                            <strong style="font-size:1.1em; color:#2c3e50;">👤 ${escapeHtml(u.name)}</strong>
                            <div style="font-size:0.85em; color:#7f8c8d; margin-top:2px;">📅 Letzte Entnahme am: ${u.neuestesDatum.toLocaleString('de-DE')} ${u.kontakt ? `&bull; 📞 ${escapeHtml(u.kontakt)}` : ''}</div>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                            <button class="btn" style="background:#f39c12; padding:6px 12px; font-size:0.85em; width:auto;" onclick="oeffneTeilrueckgabeModal('${escapeHtml(u.userKey).replace(/'/g, "\\'")}')">🔄 Teilrückgabe</button>
                            <button class="btn" style="background:#27ae60; padding:6px 12px; font-size:0.85em; width:auto;" onclick="schliesseAlleEntnahmenFuerBenutzer('${escapeHtml(u.userKey).replace(/'/g, "\\'")}')">✅ Vollständig zurückgebucht</button>
                        </div>
                    </div>
                    <div style="font-size:0.9em; color:#444;"><ul style="margin:6px 0; padding-left:20px;">${itemsHtml}</ul></div>
                </div>`;
        });
    }

    html += `<div class="kombiniert-subtitel" style="margin-top:24px;">📦 Fehlende oder unvollständige Kisten (${kistenGefiltert.length})</div>`;
    if (!kistenGefiltert.length) {
        html += `<div style="background:#edf8f0; border:1px solid #8fd0a3; padding:16px; border-radius:10px;"><p style="margin:0; color:#1f7a37; font-weight:bold;">✔️ Alle Kisten stehen vollständig im Lager.</p></div>`;
    } else {
        html += `
            <div class="table-responsive"><table>
                <thead style="background-color: #2c3e50;"><tr><th>Kiste / Lagerort</th><th>Positionen</th><th>Status / Entleiher</th><th>Aktionen</th></tr></thead>
                <tbody>${kistenGefiltert.map(o => `
                    <tr>
                        <td><strong>${escapeHtml(o.name)}</strong><br><small style="color:#7f8c8d;">${escapeHtml(o.nfc_code || 'Kein Code')}</small></td>
                        <td>${gibKistenBestand(o.id).length} Artikel</td>
                        <td>${ermittleKistenStatusCell(o.id, gibKistenBestand(o.id))}</td>
                        <td><button class="btn" style="background:#16a085; padding:8px 12px; width:auto;" onclick="oeffneKistenCheck(${o.id})">📦 Inhalt / Prüfen</button></td>
                    </tr>`).join('')}</tbody>
            </table></div>`;
    }
    ziel.innerHTML = html;
}

// -------------------------------------------------------------------------
// TEILRÜCKGABE MODAL & SPEICHERN
// -------------------------------------------------------------------------
function oeffneTeilrueckgabeModal(userKey) {
    aktiverTeilrueckgabeUserKey = userKey;
    const ents = offeneEntnahmen.filter(e => (e.benutzer_vorlage_id ? String(e.benutzer_vorlage_id) : (e.name || 'unbekannt').trim().toLowerCase()) === userKey);
    if (!ents.length) return showToast('Keine offenen Entnahmen gefunden.', 'warning');

    $('teilrueckgabe-person-name').innerText = ents[0].name || 'Unbekannt';
    const itemMap = new Map();
    ents.forEach(e => {
        extrahiereEntnahmePositionen(e).forEach(p => {
            const key = `${p.kisteId || 'null'}_${p.bestandId || p.artikelId || p.name}`;
            if (!itemMap.has(key)) itemMap.set(key, { key, name: p.name, kisteId: p.kisteId, kisteName: p.kisteName, bestandId: p.bestandId, artikelId: p.artikelId, gesamtMenge: 0, ganzeKiste: p.ganzeKiste });
            itemMap.get(key).gesamtMenge += p.menge;
        });
    });

    aktiverTeilrueckgabeItems = Array.from(itemMap.values());
    const container = $('teilrueckgabe-artikel-liste');
    if (!container) return;

    container.innerHTML = aktiverTeilrueckgabeItems.map(item => `
        <div class="teilrueck-zeile">
            <div style="flex:1;">
                <strong style="color:#2c3e50; font-size:1.02em;">${escapeHtml(item.name)}</strong>
                <div style="font-size:0.82em; color:#7f8c8d; margin-top:2px;">aus 📦 ${escapeHtml(item.kisteName || 'Kiste')} &bull; Offen bei Person: <b>${item.gesamtMenge}</b></div>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:0.85em; color:#555; font-weight:bold;">Zurück:</span>
                <button type="button" class="btn" style="width:34px; min-width:34px; height:34px; padding:0; background:#95a5a6; font-size:1.1em;" onclick="aendereTeilrueckMenge('${item.key}', -1)">−</button>
                <input type="number" id="teilrueck-qty-${item.key}" class="menge-input" value="0" min="0" max="${item.gesamtMenge}" style="width:55px; height:34px; padding:2px; font-weight:bold;" oninput="pruefeTeilrueckInput(this, ${item.gesamtMenge})">
                <button type="button" class="btn" style="width:34px; min-width:34px; height:34px; padding:0; background:#27ae60; font-size:1.1em;" onclick="aendereTeilrueckMenge('${item.key}', 1, ${item.gesamtMenge})">+</button>
                <button type="button" class="btn" style="padding:4px 8px; font-size:0.8em; background:#34495e; width:auto; height:34px;" onclick="setzeTeilrueckAlle('${item.key}', ${item.gesamtMenge})">Alle</button>
            </div>
        </div>`).join('') || '<p style="text-align:center; color:#7f8c8d;">Keine Artikel vorhanden.</p>';

    openModalById('teilrueckgabeModal');
}

function aendereTeilrueckMenge(key, delta, max) {
    const input = $(`teilrueck-qty-${key}`);
    if (input) input.value = Math.max(0, Math.min(max ?? Infinity, (parseInt(input.value, 10) || 0) + delta));
}
function setzeTeilrueckAlle(key, max) { const input = $(`teilrueck-qty-${key}`); if (input) input.value = max; }
function pruefeTeilrueckInput(input, max) { input.value = Math.max(0, Math.min(max, parseInt(input.value, 10) || 0)); }

async function speichereTeilrueckgabe() {
    if (kisteAktionInArbeit || !aktiverTeilrueckgabeUserKey) return;
    const rueckgaben = aktiverTeilrueckgabeItems.map(item => ({ ...item, returnQty: parseInt($(`teilrueck-qty-${item.key}`)?.value, 10) || 0 })).filter(r => r.returnQty > 0);
    if (!rueckgaben.length) return showToast('Bitte mindestens eine Rückgabemenge größer als 0 angeben.', 'warning');

    const ents = offeneEntnahmen.filter(e => (e.benutzer_vorlage_id ? String(e.benutzer_vorlage_id) : (e.name || 'unbekannt').trim().toLowerCase()) === aktiverTeilrueckgabeUserKey);
    kisteAktionInArbeit = true;

    try {
        for (const r of rueckgaben) {
            const b = r.bestandId ? aktuelleDaten.find(x => x.id === r.bestandId) : (r.artikelId && r.kisteId ? aktuelleDaten.find(x => x.artikel_id === r.artikelId && Number(x.lagerort_id) === Number(r.kisteId)) : null);
            if (b && Number(b.menge) >= 0) {
                const aktuell = Number(b.ist_menge) >= 0 ? Number(b.ist_menge) : 0, soll = Number(b.soll_menge) || 0;
                await dbClient.from('bestand').update({ menge: soll > 0 ? Math.min(soll, aktuell + r.returnQty) : aktuell + r.returnQty, created_at: new Date().toISOString() }).eq('id', b.id);
            }

            let verbleibend = r.returnQty;
            for (const ent of ents) {
                if (verbleibend <= 0) break;
                let geaendert = false;
                (ent.materialien || []).forEach(m => {
                    if (verbleibend <= 0 || (r.kisteId && Number(m.kiste_id) !== Number(r.kisteId))) return;
                    if (Array.isArray(m.artikel)) {
                        m.artikel.forEach(a => {
                            if (verbleibend <= 0) return;
                            if (matchesArtikel(a, r)) {
                                const abzug = Math.min(verbleibend, a.menge);
                                a.menge -= abzug;
                                verbleibend -= abzug;
                                geaendert = true;
                            }
                        });
                        m.artikel = m.artikel.filter(a => a.menge > 0);
                    } else if (m.ganze_kiste) { m.ganze_kiste = false; geaendert = true; }
                });
                if (geaendert) ent.materialien = await syncEntnahme(ent.id, ent.materialien);
            }
        }

        dbAudit({
            name: ents[0]?.name || 'Unbekannt', kontakt: ents[0]?.kontakt || '', benutzer_vorlage_id: ents[0]?.benutzer_vorlage_id || null,
            materialien: [{ kiste_id: rueckgaben[0]?.kisteId || null, kiste_name: rueckgaben[0]?.kisteName || 'Kiste', artikel: rueckgaben.map(r => ({ bestand_id: r.bestandId, artikel_id: r.artikelId, name: r.name, menge: r.returnQty })) }]
        }, 'teilrueckgabe');

        closeModal('teilrueckgabeModal');
        showToast('✅ Teilrückgabe erfolgreich verbucht!');
        await ladeAlles();
        if (kistenCheckAktuelleId) oeffneKistenCheck(kistenCheckAktuelleId);
    } catch (err) {
        showToast('Fehler bei Teilrückgabe: ' + (err.message || err), 'error');
    } finally { kisteAktionInArbeit = false; }
}

async function schliesseAlleEntnahmenFuerBenutzer(userKey) {
    if (kisteAktionInArbeit) return;
    const ents = offeneEntnahmen.filter(e => (e.benutzer_vorlage_id ? String(e.benutzer_vorlage_id) : (e.name || 'unbekannt').trim().toLowerCase()) === userKey);
    if (!ents.length) return;
    if (!confirm(`Sollen wirklich ALLE Entnahmen von ${ents[0].name || 'dieser Person'} als vollständig zurückgebracht verbucht werden?`)) return;

    kisteAktionInArbeit = true;
    try {
        for (const ent of ents) {
            for (const m of (ent.materialien || [])) {
                if (m.kiste_id && m.ganze_kiste) {
                    await Promise.all(gibKistenBestand(m.kiste_id).filter(z => Number(z.ist_menge) >= 0).map(z =>
                        dbClient.from('bestand').update({ menge: z.soll_menge > 0 ? z.soll_menge : z.ist_menge, created_at: new Date().toISOString() }).eq('id', z.id)
                    ));
                } else if (Array.isArray(m.artikel)) {
                    for (const a of m.artikel) {
                        if (!a.bestand_id) continue;
                        const b = aktuelleDaten.find(x => x.id === a.bestand_id);
                        if (b && Number(b.menge) >= 0) {
                            await dbClient.from('bestand').update({ menge: Math.min(Number(b.soll_menge) || 0, (Number(b.ist_menge) || 0) + (Number(a.menge) || 1)), created_at: new Date().toISOString() }).eq('id', b.id);
                        }
                    }
                }
            }
            dbAudit({ entnahme_id: ent.id, name: ent.name, kontakt: ent.kontakt, materialien: ent.materialien }, 'rueckgabe');
            await dbClient.from('lager_entnahmen').delete().eq('id', ent.id);
        }
        showToast(`✅ Alle Entnahmen von ${ents[0].name} abgeschlossen!`);
        await ladeAlles();
    } catch (err) {
        showToast('Fehler: ' + (err.message || err), 'error');
    } finally { kisteAktionInArbeit = false; }
}

function renderAuditLogListe() {
    const ziel = $('audit-log-bereich');
    if (!ziel) return;
    const suchText = ($('kisten-such-filter')?.value || '').toLowerCase().trim();
    const gefiltert = auditLogs.filter(a => !suchText || (a.name || '').toLowerCase().includes(suchText) || (Array.isArray(a.materialien) && a.materialien.some(m => (m.kiste_name || '').toLowerCase().includes(suchText) || (Array.isArray(m.artikel) && m.artikel.some(art => (art.name || '').toLowerCase().includes(suchText))) || (m.name || m.label || '').toLowerCase().includes(suchText))));

    if (!gefiltert.length) { ziel.innerHTML = '<p style="text-align:center; color:#7f8c8d; padding:25px;">Keine Log-Einträge gefunden.</p>'; return; }
    ziel.innerHTML = `
        <div class="table-responsive"><table>
            <thead style="background-color: #2c3e50;"><tr><th style="width:160px;">Datum &amp; Uhrzeit</th><th style="width:130px;">Aktion</th><th style="width:180px;">Person</th><th>Details / Kisten / Material</th></tr></thead>
            <tbody>${gefiltert.map(log => {
                const typ = log.ereignis || 'entnahme';
                const badge = typ === 'rueckgabe' ? '<span class="audit-badge rueckgabe">📥 Rückgabe</span>' : (typ === 'teilrueckgabe' ? '<span class="audit-badge teilrueckgabe">🔄 Teilrückgabe</span>' : '<span class="audit-badge entnahme">📤 Entnahme</span>');
                const details = (Array.isArray(log.materialien) ? log.materialien : []).map(m => {
                    if (Array.isArray(m.artikel) && m.artikel.length > 0) return m.ganze_kiste ? `📦 ${escapeHtml(m.kiste_name || 'Kiste')} (Ganze Kiste)` : m.artikel.map(a => `${a.menge || 1}x ${escapeHtml(a.name || 'Artikel')} (aus ${escapeHtml(m.kiste_name || 'Kiste')})`).join(', ');
                    return m.kiste_name ? `📦 ${escapeHtml(m.kiste_name)}` : `${m.menge || 1}x ${escapeHtml(m.name || m.label || 'Material')}`;
                }).join(', ') || '–';

                return `<tr><td><small>${new Date(log.created_at).toLocaleString('de-DE')}</small></td><td>${badge}</td><td><strong>👤 ${escapeHtml(log.name || 'Unbekannt')}</strong></td><td>${details}</td></tr>`;
            }).join('')}</tbody>
        </table></div>`;
}

async function schliesseEntnahmeKomplett(entnahmeId) {
    if (kisteAktionInArbeit || !confirm('Entnahme als vollständig zurückgebracht abschließen?')) return;
    const ent = offeneEntnahmen.find(e => String(e.id) === String(entnahmeId));
    if (!ent) return;

    kisteAktionInArbeit = true;
    try {
        for (const m of (Array.isArray(ent.materialien) ? ent.materialien : [])) {
            if (m.kiste_id && m.ganze_kiste) {
                await Promise.all(gibKistenBestand(m.kiste_id).filter(z => Number(z.ist_menge) >= 0).map(z =>
                    dbClient.from('bestand').update({ menge: z.soll_menge > 0 ? z.soll_menge : z.ist_menge, created_at: new Date().toISOString() }).eq('id', z.id)
                ));
            } else if (Array.isArray(m.artikel)) {
                for (const a of m.artikel) {
                    if (!a.bestand_id) continue;
                    const b = aktuelleDaten.find(x => x.id === a.bestand_id);
                    if (b && Number(b.menge) >= 0) {
                        await dbClient.from('bestand').update({ menge: Math.min(Number(b.soll_menge) || 0, (Number(b.ist_menge) || 0) + (Number(a.menge) || 1)), created_at: new Date().toISOString() }).eq('id', b.id);
                    }
                }
            }
        }
        dbAudit({ entnahme_id: ent.id, name: ent.name, kontakt: ent.kontakt, materialien: ent.materialien }, 'rueckgabe');
        await dbClient.from('lager_entnahmen').delete().eq('id', ent.id);
        showToast(`✅ Entnahme von ${ent.name} abgeschlossen!`);
        await ladeAlles();
    } finally { kisteAktionInArbeit = false; }
}

function openNeuOrtModal() { $('neu-ort-name').value = ''; openModalById('neuOrtModal'); }
async function speichereNeuenOrt() {
    const name = $('neu-ort-name').value.trim();
    if (!name) return;
    await dbClient.from('lagerorte').insert([{ name }]);
    closeModal('neuOrtModal');
    showToast('Lagerort angelegt!');
    await ladeAlles();
    if ($('manage-ort-select')) { populateSelect($('manage-ort-select'), alleLagerorte); ortSelectChanged(); }
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
    if ($('manage-ort-qr-box')) $('manage-ort-qr-box').style.display = 'none';
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

    const qrBox = $('manage-ort-qr-box'), preview = $('manage-ort-qr-preview');
    if (!qrBox || !preview) return;
    preview.innerHTML = '';
    new QRCode(preview, { text: `https://trilager.pius-s.de?kistencheck=${encodeURIComponent(code)}`, width: 140, height: 140 });
    qrBox.style.display = 'block';
}

function downloadEinzelKistenQr() {
    const ort = alleLagerorte.find(o => String(o.id) === String($('manage-ort-select').value));
    const canvas = $('manage-ort-qr-preview')?.querySelector('canvas');
    if (!canvas || !ort) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `QR_${ort.name.replace(/[^a-z0-9]/gi, '_')}.png`;
    a.click();
}

function druckeEinzelKistenQr() {
    const ort = alleLagerorte.find(o => String(o.id) === String($('manage-ort-select').value));
    if (ort) druckeKistenEtiketten([ort]);
}

function openKistenEtikettenModal() {
    kistenEtikettenAuswahlIds.clear();
    if ($('kisten-etiketten-alle')) $('kisten-etiketten-alle').checked = false;
    if ($('kisten-etiketten-suche')) $('kisten-etiketten-suche').value = '';
    renderKistenEtikettenListe();
    openModalById('kistenEtikettenModal');
}

function renderKistenEtikettenListe() {
    const ziel = $('kisten-etiketten-liste');
    if (!ziel) return;
    const filter = ($('kisten-etiketten-suche')?.value || '').toLowerCase().trim();
    const liste = alleLagerorte.filter(o => !filter || o.name.toLowerCase().includes(filter) || (o.nfc_code || '').toLowerCase().includes(filter));

    if (!liste.length) { ziel.innerHTML = '<p style="text-align:center; color:#7f8c8d; padding:15px;">Keine Kisten gefunden.</p>'; return; }
    ziel.innerHTML = liste.map(ort => {
        const isChk = kistenEtikettenAuswahlIds.has(String(ort.id));
        return `
            <label class="kiste-etikett-zeile" style="cursor:pointer;">
                <input type="checkbox" style="width:18px; height:18px;" ${isChk ? 'checked' : ''} onchange="toggleKistenEtikettAuswahl('${ort.id}', this.checked)">
                <div style="flex:1;">
                    <strong>📦 ${escapeHtml(ort.name)}</strong>
                    <div style="font-size:0.8em; color:#7f8c8d;">${escapeHtml(ort.nfc_code || 'Code wird beim Druck automatisch vergeben')}</div>
                </div>
            </label>`;
    }).join('');
    $('kisten-etiketten-count').textContent = kistenEtikettenAuswahlIds.size;
    $('kisten-etiketten-drucken-btn').disabled = !kistenEtikettenAuswahlIds.size;
}

function toggleKistenEtikettAuswahl(id, chk) {
    if (chk) kistenEtikettenAuswahlIds.add(String(id)); else kistenEtikettenAuswahlIds.delete(String(id));
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
    for (const ort of ausgewaehlt) await holeOderErzeugeOrtCode(ort);
    await ladeLagerorte();
    druckeKistenEtiketten(ausgewaehlt);
}

function druckeKistenEtiketten(liste) {
    const win = window.open('', '_blank');
    const itemsHtml = (liste || []).map(o => {
        const code = o.nfc_code || String(o.id);
        return `
            <div class="kiste-label-card">
                <div class="kiste-label-qr" data-link="https://trilager.pius-s.de?kistencheck=${encodeURIComponent(code)}"></div>
                <div class="kiste-label-info">
                    <div class="kiste-label-title">${escapeHtml(o.name)}</div>
                    <div class="kiste-label-sub">📦 TRISPORT LAGER</div>
                    <div class="kiste-label-code">ID: ${escapeHtml(code)}</div>
                </div>
            </div>`;
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
            .kiste-label-code { font-size: 7.5px; color: #555; font-family: monospace; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .no-p { position: fixed; top: 10px; right: 10px; padding: 10px 18px; background: #e3000f; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.2); }
            @media print { .no-p { display: none; } .kiste-label-card { border: 1px dashed transparent; } }
        </style>
        </head><body>
            <button class="no-p" onclick="window.print()">🖨️ Etiketten drucken</button>
            <div class="labels-grid">${itemsHtml}</div>
            <script>window.onload = function() { document.querySelectorAll('.kiste-label-qr').forEach(el => new QRCode(el, { text: el.dataset.link, width: 140, height: 140 })); };<\/script>
        </body></html>`);
    win.document.close();
}

// =========================================================================
// 9. ARTIKEL ANLEGEN & BEARBEITEN
// =========================================================================
function toggleEditMode() {
    isEditMode = !isEditMode;
    $('btn-edit-mode').innerText = isEditMode ? '✏️ Bearbeiten: AN' : '✏️ Bearbeiten: AUS';
    $('btn-edit-mode').style.backgroundColor = isEditMode ? '#e67e22' : '#f39c12';
    document.querySelectorAll('.lager-edit-only').forEach(el => el.style.display = isEditMode ? '' : 'none');
    wendeFilterAn();
}

function openModal() {
    $('new-name').value = ''; $('new-kategorie').value = ''; $('new-einheit').value = 'Stück';
    if ($('new-wichtig')) $('new-wichtig').checked = false;
    if ($('new-typ')) $('new-typ').value = 'zaehlbar';

    const wrapper = $('new-orte-wrapper');
    const rows = wrapper.querySelectorAll('.lagerort-row');
    for (let i = 1; i < rows.length; i++) rows[i].remove();
    const input = rows[0].querySelector('.new-menge');
    input.value = '0';
    aktualisiereMengeEingabeFarbe(input);
    setzeBestandStatus(rows[0], 'zahl');
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
    else showToast('Mindestens ein Lagerort erforderlich!', 'warning');
}

async function artikelAnlegen() {
    const name = $('new-name').value.trim(), kat = $('new-kategorie').value.trim(), einheit = $('new-einheit').value;
    const wichtig = Boolean($('new-wichtig')?.checked), typ = $('new-typ')?.value || 'zaehlbar';
    if (!name) return showToast('Bitte Namen eingeben.', 'warning');

    let artId = null;
    let ex = alleArtikelInfos.find(a => a.name.trim().toLowerCase() === name.toLowerCase());
    if (!ex) {
        const { data } = await dbClient.from('artikel').select('*').ilike('name', name);
        if (data?.length) ex = data[0];
    }

    if (ex) {
        artId = ex.id;
        await dbClient.from('artikel').update({ name, kategorie: kat, einheit, wichtig, typ }).eq('id', artId);
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
        return { artikel_id: artId, lagerort_id: row.querySelector('.new-ort').value, menge: menge < 0 ? menge : soll, alte_menge: soll };
    });

    if (inserts.length) await dbClient.from('bestand').insert(inserts);
    closeModal('artikelModal');
    showToast(ex ? 'Artikel aktualisiert!' : 'Artikel gespeichert!');
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
        else displayVal = (data.soll_menge !== undefined && data.soll_menge >= 0) ? data.soll_menge : (data.alte_menge ?? m);
    }

    div.innerHTML = `
        <div class="bestand-row-stack" style="width:100%;">
            <select class="edit-ort-select" style="width:100%; padding:10px; border-radius:6px; border:1px solid #ccc;">${options}</select>
            <div class="bestand-action-row" style="flex-wrap:nowrap; width:100%;">
                <input type="text" class="edit-menge-input bestand-menge-input bestand-form-quantity" value="${displayVal}" data-old-value="${data?.alte_menge ?? 0}" oninput="bestandEingabeGeaendert(this)" style="flex:1.25; min-width:0; padding:12px; border-radius:6px; border:1px solid #ccc; text-align:center;" title="Gesamtbestand">
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
    if (bestaende.length) bestaende.forEach(b => addEditOrtRow(b)); else addEditOrtRow();
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
            neuesIst = Math.max(0, Math.min(soll, (vorher.ist_menge >= 0 ? vorher.ist_menge : soll) + (soll - vorher.soll_menge)));
        }
        return { artikel_id: Number(aid), lagerort_id: Number(oid), menge: neuesSoll < 0 ? neuesSoll : neuesIst, alte_menge: soll };
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
    await dbClient.from('artikel').update({ kommentar: $('kommentar-text').value }).eq('id', $('kommentar-artikel-id').value);
    closeModal('kommentarModal');
    showToast('Notiz gespeichert!');
    ladeAlles();
}

// =========================================================================
// 10. EVENT-MODUS & PACKLISTEN
// =========================================================================
function wechsleModus(modus) {
    flushAllPendingArtikelUpdates();
    aktuellerModus = modus;
    ['lager', 'kisten', 'event'].forEach(m => {
        $(`ansicht-${m}`) && ($(`ansicht-${m}`).style.display = m === modus ? 'block' : 'none');
        $(`tab-${m}`) && ($(`tab-${m}`).className = m === modus ? 'btn btn-modus active' : 'btn btn-modus');
    });

    if (modus === 'kisten') {
        if (!aktiverKistenBenutzer) oeffneKistenBenutzerModal();
        setzeKistenAnsichtFilter(kistenAnsichtFilter);
    } else {
        stoppeUnterwegsAutoRefresh();
    }
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
    if (!positionen.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Noch keine Positionen in dieser Packliste.</td></tr>'; return; }

    positionen.forEach(pos => {
        const name = pos.artikel?.name || pos.eigener_name || 'Unbekannt';
        let verfuegbar = '-', status = '<span class="event-ok">✅ OK</span>';

        if (pos.artikel_id) {
            verfuegbar = aktuelleDaten.filter(b => b.artikel_id === pos.artikel_id).reduce((sum, b) => sum + (Number(b.ist_menge) >= 0 ? Number(b.ist_menge) : 0), 0);
            if (verfuegbar < pos.menge) status = `<span class="event-warning">❌ Zu wenig (${verfuegbar - pos.menge})</span>`;
        }

        const mengeZelle = isEventEditMode ? `<input type="text" class="menge-input" value="${pos.menge}" onchange="speicherePackMengeDirekt(${pos.id}, this.value)" style="width:65px; height:34px; padding:4px;">` : `<strong>${pos.menge}</strong>`;
        const actionCell = isEventEditMode ? `
            <button class="btn" style="background:#3498db; padding:4px 8px; font-size:0.8em; margin-left:8px;" onclick="openPackItemModal(${pos.id})" title="Position bearbeiten">✏️</button>
            <button class="btn" style="background:#e74c3c; padding:4px 8px; font-size:0.8em; margin-left:4px;" onclick="loeschePackPosition(${pos.id})" title="Löschen">🗑️</button>` : '';

        tbody.innerHTML += `<tr><td><strong>${escapeHtml(name)}</strong></td><td>${mengeZelle}</td><td>${verfuegbar}</td><td>${status} ${actionCell}</td></tr>`;
    });
}

async function speicherePackMengeDirekt(posId, rawVal) {
    const neueMenge = werteMengeAus(rawVal) || 1;
    const { error } = await dbClient.from('packlisten_positionen').update({ menge: neueMenge }).eq('id', posId);
    if (error) showToast('Fehler beim Speichern: ' + error.message, 'error');
    else { showToast(`Menge auf ${neueMenge} geändert!`); await ladePacklistenDaten(); zeigePackliste(); }
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
    const idInp = $('pack-pos-id'), titleEl = $('pack-modal-title'), btnEl = $('pack-modal-save-btn');

    if (posId) {
        const pos = packlistenPositionen.find(p => p.id === posId);
        if (!pos) return;
        if (idInp) idInp.value = pos.id;
        if (titleEl) titleEl.innerText = 'Position bearbeiten';
        if (btnEl) btnEl.innerText = 'Speichern';
        $('pack-typ').value = pos.artikel_id ? 'lager' : 'custom';
        $('pack-artikel-input').value = pos.artikel?.name || '';
        $('pack-eigener-name').value = pos.eigener_name || '';
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
    const plId = $('packlisten-auswahl').value, typ = $('pack-typ').value;
    const menge = werteMengeAus($('pack-menge').value) || 1, editId = $('pack-pos-id')?.value;
    let artikelId = null, eigenerName = null;

    if (typ === 'lager') {
        const art = alleArtikelInfos.find(a => a.name.toLowerCase() === $('pack-artikel-input').value.trim().toLowerCase());
        if (!art) return showToast('Artikel nicht im Lager gefunden.', 'warning');
        artikelId = art.id;
    } else {
        eigenerName = $('pack-eigener-name').value.trim();
        if (!eigenerName) return showToast('Bitte Namen eingeben.', 'warning');
    }

    const payload = { packliste_id: Number(plId), menge, artikel_id: artikelId, eigener_name: eigenerName };
    const { error } = editId ? await dbClient.from('packlisten_positionen').update(payload).eq('id', editId) : await dbClient.from('packlisten_positionen').insert([payload]);
    if (error) return showToast('Fehler: ' + error.message, 'error');

    showToast(editId ? 'Position aktualisiert!' : 'Position hinzugefügt!');
    closeModal('packItemModal');
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
    autoFehlbestandListe = []; eigeneVorschlaegeListe = []; manuelleEintraegeListe = [];
    const bestandMap = {}, nachkaufSet = new Set(), bedarfMap = {}, eigeneMap = {};

    aktuelleDaten.forEach(b => {
        const m = Number(b.menge);
        if (m === BESTAND_STRICH_NACHKAUF) nachkaufSet.add(String(b.artikel_id));
        else if (m === -1) bestandMap[b.artikel_id] = Infinity;
        else if (m >= 0) bestandMap[b.artikel_id] = (bestandMap[b.artikel_id] || 0) + (b.ist_menge >= 0 ? b.ist_menge : m);
    });

    packlistenPositionen.forEach(p => {
        if (p.artikel_id) bedarfMap[p.artikel_id] = (bedarfMap[p.artikel_id] || 0) + Number(p.menge);
        else if (p.eigener_name) eigeneMap[p.eigener_name] = (eigeneMap[p.eigener_name] || 0) + Number(p.menge);
    });

    alleArtikelInfos.forEach(art => {
        const bestand = nachkaufSet.has(String(art.id)) ? 0 : (bestandMap[art.id] || 0);
        const bedarf = bedarfMap[art.id] || 0;
        if (nachkaufSet.has(String(art.id))) autoFehlbestandListe.push({ artikel: art.name, menge: Math.max(1, bedarf), grund: 'Nachkauf markiert (🔴)' });
        else if (bedarf > bestand) autoFehlbestandListe.push({ artikel: art.name, menge: bedarf - bestand, grund: 'Fehlt im Lager für Packliste' });
    });

    if ($('auto-kauf-liste')) {
        $('auto-kauf-liste').innerHTML = autoFehlbestandListe.length 
            ? autoFehlbestandListe.map(i => `<li><strong>${i.menge}x</strong> ${escapeHtml(i.artikel)} <small style="color:#7f8c8d;">(${i.grund})</small></li>`).join('')
            : '<li style="color:#27ae60;">Alles grün! Keine Fehlbestände.</li>';
    }

    if ($('eigene-kauf-liste')) {
        $('eigene-kauf-liste').innerHTML = Object.entries(eigeneMap).map(([name, m], idx) => {
            eigeneVorschlaegeListe.push({ artikel: name, menge: m, grund: 'Sonderposten Packliste' });
            return `<li style="margin-bottom:6px;"><label style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="checkbox" class="eigene-kauf-check" data-index="${idx}" checked onchange="aktualisiereEinkaufslisteAuswahl()"><span>${m}x ${escapeHtml(name)}</span></label></li>`;
        }).join('') || '<li style="color:#7f8c8d;">Keine Sonderposten in Packlisten.</li>';
    }

    if ($('manuell-kauf-liste')) $('manuell-kauf-liste').innerHTML = '';
    aktualisiereEinkaufslisteAuswahl();
    openModalById('kauflisteModal');
}

function aktualisiereEinkaufslisteAuswahl() {
    const ausgewaehlt = Array.from(document.querySelectorAll('.eigene-kauf-check:checked')).map(chk => eigeneVorschlaegeListe[Number(chk.dataset.index)]).filter(Boolean);
    einkaufslisteArray = [...autoFehlbestandListe, ...ausgewaehlt, ...manuelleEintraegeListe];
}

function manuellAufZettel() {
    const n = $('manuell-kauf-name')?.value.trim(), m = werteMengeAus($('manuell-kauf-menge')?.value) || 1;
    if (!n || m <= 0) return;
    manuelleEintraegeListe.push({ artikel: n, menge: m, grund: 'Manuell hinzugefügt' });
    aktualisiereEinkaufslisteAuswahl();
    if ($('manuell-kauf-liste')) $('manuell-kauf-liste').innerHTML += `<li>${m}x ${escapeHtml(n)}</li>`;
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
// 11. REGAL-QR & FEEDBACK
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
    const frage1 = $('formular-frage1')?.value.trim() || '', frage2 = $('formular-frage2')?.value.trim() || '';
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
// 12. APP STARTUP / DOMCONTENTLOADED
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    window.addEventListener('beforeunload', () => { flushAllPendingArtikelUpdates(); });

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
        ladeKistenBenutzerSession();
        await ladeAlles();
        if (!window.localStorage.getItem(STORAGE_KEYS.ONBOARDING)) openModalById('onboardingModal');

        const kistenCode = urlParams.get('kistencheck');
        if (kistenCode) verarbeiteUniversalScan('kistencheck=' + kistenCode);
    } else {
        $('login-overlay').style.display = 'flex';
    }
});
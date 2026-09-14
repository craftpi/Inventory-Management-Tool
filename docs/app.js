// =========================================================================
// 1. KONFIGURATION & GLOBALE ZUSTÄNDE
// =========================================================================
const SUPABASE_URL = 'https://trilager-api.pius-s.de';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InRyaWxhZ2VyIiwiaWF0IjoxNzg1ODA3MzI1LCJleHAiOjIxMDExNjczMjV9.COsEZ-KOGycjE2S1eALGohmmjosW8CZs038jezg6lSU';

const URL_PARAMS = new URLSearchParams(window.location.search);
const FORMULAR_MODUS = URL_PARAMS.get('formular') === '1';
const QRGEN_MODUS = URL_PARAMS.get('qrgen') === '1';
const ENTNAHME_MODUS = URL_PARAMS.get('entnahme') === '1';
const ETIKETTEN_MODUS = URL_PARAMS.get('etiketten') === '1';
const INITIAL_REGAL_FILTER = URL_PARAMS.get('regal') || '';

const STORAGE_KEYS = {
    SESSION: 'trilager_local_session_v2',
    ATTEMPTS: 'trilager_login_attempts_v1',
    LOCK: 'trilager_login_lock_until_v1',
    ENTNAHME_DRAFT: 'inventory-management-tool.entnahmeDraft.v2',
    ONBOARDING: 'lager_onboarding_v1_gesehen'
};

const TABLES = {
    FORMULAR: 'formular_antworten',
    ENTNAHME: 'lager_entnahmen',
    BENUTZER_VORLAGEN: 'lager_entnahme_benutzer_vorlagen',
    SAMMEL_VORLAGEN: 'lager_entnahme_sammelvorlagen',
    AUDIT: 'lager_entnahme_audit'
};

const BESTAND_STRICH_AUSREICHEND = -2;
const BESTAND_STRICH_NACHKAUF = -3;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_DURATION_MS = 5 * 60 * 1000;
const LOCAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

// App-Datenzustände
let aktuelleDaten = [], packlisten = [], packlistenPositionen = [], alleArtikelInfos = [], alleLagerorte = [];
let isEditMode = false, isEventEditMode = false, aktuellerModus = 'lager';
let offeneGruppen = new Set(), isAllOpen = false, sortAscending = true, zeigeAlleArtikel = false;
let aktiverRegalFilter = extrahiereRegalName(INITIAL_REGAL_FILTER);
let einkaufslisteArray = [], autoFehlbestandListe = [], eigeneVorschlaegeListe = [], manuelleEintraegeListe = [], artikelIgnorieren = new Set();

// Entnahme- & Wizard-Zustände
let entnahmeBenutzerVorlagen = [], entnahmeSammelvorlagen = [], entnahmeMaterialien = [], entnahmeHistorie = [];
let entnahmeVorlagenBearbeiten = false, entnahmeHistorieGeoeffnet = new Set();
let entnahmeAuswahlBenutzerId = '', entnahmeAuswahlSammelId = '', entnahmeBenutzerNeuAktiv = false, entnahmeSammelNeuAktiv = false;
let entnahmeVerbrauchProArtikel = {}, entnahmeWizardStep = 1, entnahmeActiveDraftId = '', entnahmeWizardAutoAdvanceAktiv = true;
let entnahmeAutoSaveTimer = null, entnahmeAutoSaveInFlight = false, entnahmeMarkiereTimer = null;
let entnahmeSammelAutoSaveTimer = null, entnahmeSammelVorlageBestaetigtFuerId = '', entnahmeSammelAutoSaveInFlight = false, entnahmeSammelAutoSaveNachholen = false;
let entnahmeLogEintraege = [], entnahmeLogGeladen = false;

// Kisten- & Scan-Zustände
let kistenCheckAktuelleId = '', kistenScanAktion = 'check';
let scanSperre = { rueckgabe: false, ausbuchen: false, kisten: false };
let aktiverQrScanner = null;
let aktiverNfcModus = null;
let nfcAbortController = null;
let etikettenAuswahlIds = new Set();
let _bestaetigungResolve = null;

// =========================================================================
// 2. ALLGEMEINE HILFSFUNKTIONEN (DOM, FORMATIERUNG, MATH, TOAST)
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

// Sicherer Mini-Parser für Mengenberechnungen (z.B. "3+2" oder "(4-1)*2")
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
    if (id === null || id === undefined || id === '') return '–';
    const n = Number(id);
    return Number.isFinite(n) ? '#' + String(n).padStart(5, '0') : String(id);
}

// Dialog-Promise für modale Bestätigungen
function zeigeBestaetigungsDialog({ titel = 'Bist du sicher?', text = '', okText = 'OK', okFarbe = '#e74c3c', icon = '⚠️' } = {}) {
    return new Promise(resolve => {
        const modal = $('bestaetigungModal');
        if (!modal) return resolve(window.confirm(text || titel));
        $('bestaetigung-titel').textContent = titel;
        $('bestaetigung-text').textContent = text;
        $('bestaetigung-icon').textContent = icon;
        const okBtn = $('bestaetigung-ok-btn');
        okBtn.textContent = okText;
        okBtn.style.background = okFarbe;
        _bestaetigungResolve = resolve;
        modal.style.display = 'block';
    });
}
function bestaetigungBestaetigen() { closeModal('bestaetigungModal'); if (_bestaetigungResolve) { _bestaetigungResolve(true); _bestaetigungResolve = null; } }
function bestaetigungAbbrechen() { closeModal('bestaetigungModal'); if (_bestaetigungResolve) { _bestaetigungResolve(false); _bestaetigungResolve = null; } }

// =========================================================================
// 3. AUTH & SESSION VERWALTUNG
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
        userId: String(user?.id || ''),
        userName: String(user?.username || user?.name || ''),
        token: String(user?.token || ''),
        issuedAt: Date.now(),
        expiresAt: Date.now() + LOCAL_SESSION_TTL_MS
    };
    window.localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session));
    setzeAuthToken(session.token);
}

function loescheLokaleSession() { window.localStorage.removeItem(STORAGE_KEYS.SESSION); }
function holeLoginSperreBis() { try { return Number(window.localStorage.getItem(STORAGE_KEYS.LOCK) || '0') || 0; } catch { return 0; } }

function fuegeLoginFehlversuchHinzu() {
    const now = Date.now(), lock = holeLoginSperreBis();
    if (lock > now) return lock;
    const att = (Number(window.localStorage.getItem(STORAGE_KEYS.ATTEMPTS) || '0') || 0) + 1;
    window.localStorage.setItem(STORAGE_KEYS.ATTEMPTS, String(att));
    if (att >= LOGIN_MAX_ATTEMPTS) {
        const gesperrt = now + LOGIN_LOCK_DURATION_MS;
        window.localStorage.setItem(STORAGE_KEYS.LOCK, String(gesperrt));
        window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
        return gesperrt;
    }
    return 0;
}

function setzeLoginFehlversucheZurueck() {
    window.localStorage.removeItem(STORAGE_KEYS.ATTEMPTS);
    window.localStorage.removeItem(STORAGE_KEYS.LOCK);
}

async function handleLogin() {
    const p = $('login-password').value;
    const lockUntil = holeLoginSperreBis();
    const errEl = $('login-error');

    if (lockUntil > Date.now()) {
        const sec = Math.ceil((lockUntil - Date.now()) / 1000);
        if (errEl) { errEl.innerText = `Zu viele Fehlversuche. Bitte in ${sec}s erneut versuchen.`; errEl.style.display = 'block'; }
        return;
    }

    const { data, error } = await dbClient.rpc('login_user', { p_password: p });
    if (error || !data || data.length === 0) {
        const lock = fuegeLoginFehlversuchHinzu();
        if (errEl) {
            errEl.style.display = 'block';
            errEl.innerText = lock > Date.now() ? `Gesperrt für ${Math.ceil((lock - Date.now()) / 1000)}s.` : 'Falsches Passwort!';
        }
    } else {
        if (errEl) errEl.style.display = 'none';
        $('login-password').value = '';
        $('login-overlay').style.display = 'none';
        setzeLoginFehlversucheZurueck();
        speichereLokaleSession({ username: data.username, token: data.token });
        showToast('Erfolgreich angemeldet!');

        if (ENTNAHME_MODUS) return initEntnahmeModus();
        if (ETIKETTEN_MODUS) return initEtikettenModus();
        ladeAlles();
        pruefeUndZeigeOnboarding();
        pruefeUndVerarbeiteRueckgabeLink();
        pruefeUndVerarbeiteKistencheckLink();
    }
}

async function handleLogout() {
    loescheLokaleSession();
    setzeAuthToken(null);
    setzeLoginFehlversucheZurueck();
    $('login-overlay').style.display = 'flex';
    $('lager-tabelle').innerHTML = '';
    showToast('Abgemeldet.');
}

// =========================================================================
// 4. HARDWARE I/O: ZENTRALES SCANNING (KAMERA & NFC)
// =========================================================================

// --- Universeller Kamera-Scanner (Html5Qrcode) ---
async function starteKameraScanner({ modalId, readerId, statusId, onDecode, readyMsg }) {
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
        if (status) status.innerText = readyMsg || 'Bereit – Etikett vor die Kamera halten.';
    } catch (err) {
        console.error(err);
        showToast('Kamera konnte nicht gestartet werden. Berechtigung erteilt?', 'error');
        stoppeKameraScanner(modalId);
    }
}

function stoppeKameraScanner(modalId) {
    if (aktiverQrScanner) {
        aktiverQrScanner.stop().then(() => aktiverQrScanner.clear()).catch(() => {}).finally(() => { aktiverQrScanner = null; });
    }
    closeModal(modalId);
}

// Scanner-Wrapper für die HTML-Aufrufe
function oeffneRueckgabeKameraModal() {
    starteKameraScanner({ modalId: 'rueckgabeKameraModal', readerId: 'rueckgabe-qr-reader', statusId: 'rueckgabe-scanner-status', onDecode: verarbeiteRueckgabeScan });
}
function schliesseRueckgabeKameraModal() { stoppeKameraScanner('rueckgabeKameraModal'); }
function oeffneAusbuchenKameraModal() {
    starteKameraScanner({ modalId: 'ausbuchenKameraModal', readerId: 'ausbuchen-qr-reader', statusId: 'ausbuchen-scanner-status', onDecode: verarbeiteAusbuchenScan });
}
function schliesseAusbuchenKameraModal() { stoppeKameraScanner('ausbuchenKameraModal'); }
function oeffneKistenKameraModal() { kistenScanAktion = 'check'; oeffneKistenKameraModalOhneReset(); }
function starteEventKistenZuweisungScan() {
    if (!$('packlisten-auswahl')?.value) return showToast('Bitte zuerst ein Event auswählen.', 'warning');
    kistenScanAktion = 'zuweisen';
    oeffneKistenKameraModalOhneReset();
}
function oeffneKistenKameraModalOhneReset() {
    starteKameraScanner({
        modalId: 'kistenKameraModal', readerId: 'kisten-qr-reader', statusId: 'kisten-scanner-status',
        onDecode: verarbeiteOrtScan,
        readyMsg: kistenScanAktion === 'zuweisen' ? 'Bereit – Kiste diesem Event zuweisen: Etikett vor die Kamera halten.' : 'Bereit – NFC-Etikett vor die Kamera halten.'
    });
}
function schliesseKistenKameraModal() { stoppeKameraScanner('kistenKameraModal'); }

// --- Universelle NFC Engine ---
function deaktiviereNfcModus(modus) {
    if (typeof window.nfc !== 'undefined') {
        try { window.nfc.removeNdefListener(); } catch {}
    }
    if (nfcAbortController) {
        nfcAbortController.abort();
        nfcAbortController = null;
    }
    if (aktiverNfcModus === modus || !modus) aktiverNfcModus = null;
    aktualisiereNfcModusUI();
}
function deaktiviereAlleNfcModi() { deaktiviereNfcModus(null); }

function decodeNfcRecord(record) {
    if (!record) return '';
    if (typeof window.nfc !== 'undefined' && record.tnf !== undefined) {
        if (record.tnf === 1 && record.type?.[0] === 85) return window.ndef.uriHelper.decodePayload(record.payload);
        if (record.tnf === 1 && record.type?.[0] === 84) return window.ndef.textHelper.decodePayload(record.payload);
        return window.nfc.bytesToString(record.payload);
    }
    if (record.recordType === 'url' || record.recordType === 'absolute-url') return new TextDecoder().decode(record.data);
    if (record.recordType === 'text') return new TextDecoder(record.encoding || 'utf-8').decode(record.data);
    return '';
}

async function starteNfcModus(modus, onScanFn) {
    if (aktiverNfcModus === modus) {
        deaktiviereNfcModus(modus);
        return showToast(`📶 NFC-${modus}-Modus gestoppt.`, 'success');
    }

    deaktiviereAlleNfcModi();
    aktiverNfcModus = modus;
    aktualisiereNfcModusUI();

    // App (Capacitor/Phonegap)
    if (typeof window.nfc !== 'undefined') {
        showToast('📶 App-NFC aktiv – Tag ans Handy halten.', 'success');
        window.nfc.addNdefListener(evt => {
            if (aktiverNfcModus !== modus) return;
            try {
                const text = decodeNfcRecord(evt.tag?.ndefMessage?.[0]);
                if (text) onScanFn(text);
            } catch { showToast('NFC-Tag konnte nicht gelesen werden.', 'error'); }
        }, () => {}, err => showToast('NFC-Fehler: ' + err, 'error'));
        return;
    }

    // Web NFC (Chrome Android)
    if (!('NDEFReader' in window)) {
        showToast('Web NFC wird von diesem Browser nicht unterstützt.', 'error');
        aktiverNfcModus = null;
        return aktualisiereNfcModusUI();
    }

    try {
        nfcAbortController = new AbortController();
        const reader = new NDEFReader();
        await reader.scan({ signal: nfcAbortController.signal });
        showToast('📶 Web-NFC aktiv – Tag ans Handy halten.', 'success');
        reader.onreading = (event) => {
            if (aktiverNfcModus !== modus) return;
            for (const rec of event.message.records) {
                const text = decodeNfcRecord(rec);
                if (text) { onScanFn(text); break; }
            }
        };
        reader.onreadingerror = () => showToast('NFC-Tag konnte nicht gelesen werden.', 'error');
    } catch (err) {
        if (err.name !== 'AbortError') showToast('NFC Fehler: ' + err, 'error');
        aktiverNfcModus = null;
        aktualisiereNfcModusUI();
    }
}

function starteRueckgabeNfc() { starteNfcModus('rueckgabe', verarbeiteRueckgabeScan); }
function starteAusbuchenNfc() { starteNfcModus('ausbuchen', verarbeiteAusbuchenScan); }
function starteKistenNfc(aktion = 'check') { kistenScanAktion = aktion; starteNfcModus('kisten', verarbeiteOrtScan); }

function aktualisiereNfcModusUI() {
    const btns = { rueckgabe: $('rueckgabe-nfc-btn'), ausbuchen: $('ausbuchen-nfc-btn'), kisten: $('kisten-nfc-btn') };
    Object.entries(btns).forEach(([m, b]) => {
        if (!b) return;
        const isActive = aktiverNfcModus === m;
        b.classList.toggle('nfc-aktiv', isActive);
        b.innerText = isActive ? '📶 NFC aktiv – antippen zum Stoppen' : '📶 NFC-Scan (Android)';
    });
}

// Universelle NFC-Schreibroutine
async function schreibeNfcUrlTag(url, label) {
    if (typeof window.nfc !== 'undefined') {
        showToast('📶 App: NFC-Tag jetzt an das Handy halten…', 'success');
        const writeAction = () => {
            window.nfc.write([window.ndef.uriRecord(url)], () => {
                if (navigator.vibrate) navigator.vibrate(200);
                showToast(`✅ NFC-Tag für "${label}" beschrieben!`, 'success');
                window.nfc.removeNdefListener();
                window.nfc.removeNdefFormatableListener();
            }, err => {
                showToast('Schreiben fehlgeschlagen: ' + err, 'error');
                window.nfc.removeNdefListener();
                window.nfc.removeNdefFormatableListener();
            });
        };
        window.nfc.addNdefListener(writeAction, () => {}, () => {});
        window.nfc.addNdefFormatableListener(writeAction, () => {}, () => {});
        return;
    }

    if (!('NDEFReader' in window)) return showToast('NFC-Beschreiben wird von diesem Browser nicht unterstützt.', 'error');

    try {
        const writer = new NDEFReader();
        showToast('📶 Web-NFC: Leeren NFC-Tag ans Handy halten…', 'success');
        await writer.write({ records: [{ recordType: 'url', data: url }] });
        if (navigator.vibrate) navigator.vibrate(200);
        showToast(`✅ NFC-Tag für "${label}" beschrieben!`, 'success');
    } catch (err) { showToast('Schreiben fehlgeschlagen: ' + err, 'error'); }
}

// Native App Hooks
window.onNativeNfcRead = (payload, action) => {
    if (action === 'rueckgabe') verarbeiteRueckgabeScan(payload);
    else if (action === 'ausbuchen') verarbeiteAusbuchenScan(payload);
    else if (action === 'kisten') verarbeiteOrtScan(payload);
};
window.onNativeNfcWriteResult = (success, msg) => {
    if (navigator.vibrate) navigator.vibrate(success ? 200 : [100, 60, 100]);
    showToast(success ? '✅ NFC-Tag erfolgreich beschrieben!' : 'App-Schreiben Fehler: ' + msg, success ? 'success' : 'error');
};

// =========================================================================
// 5. LAGER-MODUS (BESTAND, FILTER, RENDERING, EDITIEREN)
// =========================================================================

function extrahiereArtikelIdAusScan(rawText) {
    const text = String(rawText || '').trim();
    const matchSimple = /^artikel:(.+)$/i.exec(text);
    if (matchSimple) return matchSimple[1].trim();
    const matchUrl = /rueckgabe=([^&\s]+)/i.exec(text);
    return matchUrl ? matchUrl[1].trim() : null;
}

function extrahiereOrtCodeAusScan(rawText) {
    const text = String(rawText || '').trim();
    const m1 = /^(?:ort|behaelter):(.+)$/i.exec(text);
    if (m1) return m1[1].trim();
    const m2 = /kistencheck=([^&\s]+)/i.exec(text);
    return m2 ? decodeURIComponent(m2[1].trim()) : null;
}

async function ladeAlles() {
    await ladeLagerorte();
    const { data: listData } = await dbClient.from('packlisten').select('*');
    packlisten = listData || [];
    const resPos = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie, einheit)');
    packlistenPositionen = resPos.data || [];
    await ladeBestand();
    await ladeAktuelleEntnahmeVerbraeuche();
    wendeFilterAn();
    if (aktuellerModus === 'event') await ladeEventDaten();
    if (aktuellerModus === 'kisten') renderKistenListe();
}

async function ladeLagerorte() {
    const { data } = await dbClient.from('lagerorte').select('*').order('name');
    if (!data) return;
    alleLagerorte = data;

    const selectsNeu = document.querySelectorAll('.new-ort');
    const selectEdit = $('edit-ort');
    selectsNeu.forEach(sel => populateSelect(sel, data));
    if (selectEdit) populateSelect(selectEdit, data);

    const def = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
    if (def) selectsNeu.forEach(sel => sel.value = def.id);
}

async function ladeBestand() {
    const { data: alleArt } = await dbClient.from('artikel').select('*').order('name');
    alleArtikelInfos = alleArt || [];

    let { data, error } = await dbClient.from('bestand').select(`id, menge, alte_menge, created_at, artikel_id, lagerort_id, artikel (id, name, kategorie, einheit, kommentar), lagerorte (id, name)`).order('id');
    if (error) {
        const fallback = await dbClient.from('bestand').select(`id, menge, alte_menge, artikel_id, lagerort_id, artikel (id, name, kategorie, einheit, kommentar), lagerorte (id, name)`).order('id');
        data = fallback.data;
    }

    const wichtigMap = new Map(alleArtikelInfos.map(art => [String(art.id), Boolean(art.wichtig)]));
    aktuelleDaten = (data || []).map(z => ({
        ...z,
        artikel: z.artikel ? { ...z.artikel, wichtig: wichtigMap.get(String(z.artikel_id)) || Boolean(z.artikel.wichtig) } : z.artikel
    }));

    aktualisiereFilterDropdown(aktuelleDaten);
    wendeFilterAn();
    aktualisiereEntnahmeMaterialDatalist();
}

function aktualisiereFilterDropdown(daten) {
    const katDropdown = $('kategorie-filter'), datalist = $('kategorie-liste'), comboDropdown = $('ort-filter-combo');
    const kategorien = new Set(), regale = new Set();

    daten.forEach(z => {
        if (z.artikel?.kategorie?.trim()) kategorien.add(z.artikel.kategorie.trim());
        const regal = extrahiereRegalName(z.lagerorte?.name || '');
        if (regal) regale.add(regal);
    });

    if (katDropdown) {
        populateSelect(katDropdown, Array.from(kategorien).sort(), { defaultOption: 'Alle Kategorien' });
    }
    if (comboDropdown) {
        comboDropdown.innerHTML = '<option value="">Alle Orte</option>';
        Array.from(alleLagerorte).sort((a, b) => a.name.localeCompare(b.name, 'de')).forEach(o => comboDropdown.add(new Option('📍 ' + o.name, 'ort:' + o.id)));
        Array.from(regale).sort(vergleicheRegalNamen).forEach(r => comboDropdown.add(new Option('🏷️ Regal: ' + r, 'regal:' + r)));
        if (aktiverRegalFilter) comboDropdown.value = 'regal:' + aktiverRegalFilter;
    }
    if (datalist) {
        datalist.innerHTML = Array.from(kategorien).sort().map(k => `<option value="${escapeHtml(k)}">`).join('');
    }
}

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
    if (val.startsWith('regal:')) setzeRegalFilter(val.substring(6), true);
    else {
        aktiverRegalFilter = '';
        const url = new URL(window.location.href);
        url.searchParams.delete('regal');
        window.history.replaceState({}, '', url.toString());
        wendeFilterAn();
    }
}

function setzeRegalFilter(regalText, syncUrl = true) {
    aktiverRegalFilter = extrahiereRegalName(regalText);
    if (syncUrl) {
        const url = new URL(window.location.href);
        if (aktiverRegalFilter) url.searchParams.set('regal', aktiverRegalFilter);
        else url.searchParams.delete('regal');
        window.history.replaceState({}, '', url.toString());
    }
    if ($('ort-filter-combo')) $('ort-filter-combo').value = aktiverRegalFilter ? 'regal:' + aktiverRegalFilter : '';
    if ($('regal-qr-input') && $('regal-qr-input').value !== regalText) $('regal-qr-input').value = regalText || '';
    aktualisiereRegalQrVorschau();
    wendeFilterAn();
}

function toggleSortierung() {
    sortAscending = !sortAscending;
    if ($('btn-sort')) $('btn-sort').innerText = sortAscending ? 'A-Z' : 'Z-A';
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
function toggleAlleArtikelSichtbarkeit() { zeigeAlleArtikel = !zeigeAlleArtikel; wendeFilterAn(); }

function tabelleAktualisieren(daten) {
    const tbody = $('lager-tabelle');
    if (!tbody) return;
    tbody.innerHTML = '';

    const suchText = $('such-filter')?.value.trim() || '';
    const isSearching = suchText.length > 0 || aktiverRegalFilter !== '';

    // Reservierungen aus Packlisten vorberechnen
    const resMap = {};
    packlistenPositionen.forEach(p => {
        if (!p.artikel_id) return;
        if (!resMap[p.artikel_id]) resMap[p.artikel_id] = { gesamt: 0, listen: {} };
        resMap[p.artikel_id].gesamt += Number(p.menge);
        const pl = packlisten.find(l => String(l.id) === String(p.packliste_id));
        const plName = pl ? pl.name : 'Unbekannt';
        resMap[p.artikel_id].listen[plName] = (resMap[p.artikel_id].listen[plName] || 0) + Number(p.menge);
    });

    const anzeigeDaten = (zeigeAlleArtikel || aktiverRegalFilter !== '') ? daten : daten.filter(z => z.artikel?.wichtig);
    const gruppen = {};
    anzeigeDaten.forEach(z => {
        if (!z.artikel) return;
        const kat = z.artikel.kategorie || 'Ohne Kategorie';
        if (!gruppen[kat]) gruppen[kat] = [];
        gruppen[kat].push(z);
    });

    const sortFactor = sortAscending ? 1 : -1;
    const sortedKategorien = Object.keys(gruppen).sort((a, b) => {
        if (a === 'Ohne Kategorie') return 1; if (b === 'Ohne Kategorie') return -1;
        return a.localeCompare(b, 'de') * sortFactor;
    });

    if (anzeigeDaten.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:24px; color:#666;">${zeigeAlleArtikel ? 'Keine Artikel vorhanden.' : 'Keine markierten Artikel sichtbar.'}</td></tr>`;
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

        // Artikel-Prefix-Gruppierung
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
                if (window.hoverWasLongPress) return;
                if (!['INPUT', 'BUTTON', 'SVG', 'PATH'].includes(e.target.tagName)) openEditModal(artId);
            };

            const displayName = isGrp ? grp.artikel.name.trim().substring(pref.length).trim() : grp.artikel.name;
            const wichtigBadge = grp.artikel.wichtig ? '<span class="badge-markiert">MARKIERT</span>' : '';
            const hatKommentar = Boolean(grp.artikel.kommentar?.trim());
            const kommentarIcon = isEditMode ? `
                <span onclick="openKommentarModal('${artId}', event)" style="cursor:pointer; margin-left:8px; vertical-align:middle; opacity:${hatKommentar ? '1' : '0.5'};" title="Kommentar bearbeiten">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="${hatKommentar ? '#3498db' : 'none'}" stroke="${hatKommentar ? '#3498db' : '#bdc3c7'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                </span>` : '';
            const kommentarAnzeige = !isEditMode && hatKommentar ? `
                <div class="bestand-kommentar-anzeige">
                    <span style="color:#3498db;">💬</span>
                    <span style="word-break:break-word;">${escapeHtml(grp.artikel.kommentar.trim())}</span>
                </div>` : '';

            let latestDate = null;
            grp.bestaende.forEach(b => { if (b.created_at && (!latestDate || new Date(b.created_at) > latestDate)) latestDate = new Date(b.created_at); });
            const dateStr = latestDate ? latestDate.toLocaleDateString('de-DE') + ' ' + latestDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' : 'Unbekannt';

            // Reservierungs-Hover
            let resHtml = '';
            const res = resMap[artId];
            if (res && res.gesamt > 0 && !grp.bestaende.some(b => Number(b.menge) === -1)) {
                let hoverText = '<strong>Reserviert für:</strong><br>' + Object.entries(res.listen).map(([l, m]) => `• ${m}x in <i>${escapeHtml(l)}</i><br>`).join('');
                resHtml = `<div class="no-select bestand-reserviert-info" data-hover-type="res" data-hover-content="${hoverText}" onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)" ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)">📦 Reserviert: ${res.gesamt}</div>`;
            }

            // Bestände & Verfügbarkeit
            const hatNachkauf = grp.bestaende.some(b => Number(b.menge) === -3);
            const hatMinus = grp.bestaende.some(b => Number(b.menge) === -2 || Number(b.menge) === -3);
            const verfuegbar = berechneArtikelVerfuegbarkeit(artId, grp.bestaende);
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
                return `<div class="bestand-ort-row"><span class="bestand-ort-name">📍 ${escapeHtml(b.lagerorte.name)}</span>${zelle}</div>`;
            }).join('');

            const vFarbe = hatNachkauf ? '#c0392b' : (hatMinus ? '#27ae60' : (verfuegbar === '∞' ? '#7f8c8d' : (Number(verfuegbar) > 0 ? '#27ae60' : '#c0392b')));
            const vText = hatNachkauf ? 'Nachkaufen' : (hatMinus ? 'Verfügbar' : (verfuegbar === '∞' ? '∞' : verfuegbar));

            tr.innerHTML = `
                <td class="no-select" style="padding-left:${isGrp ? 45 : 25}px; vertical-align:top;" data-hover-type="date" data-hover-content="${dateStr}" onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)" ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)">
                    ${isGrp ? '◦' : '↳'} <strong>${escapeHtml(displayName)}</strong>${wichtigBadge}${kommentarIcon}${kommentarAnzeige}
                    <div class="bestand-id-anzeige" style="font-size:0.7em; color:#b0b0b0; margin-top:2px;">ID: ${escapeHtml(String(grp.artikel.id))}</div>
                </td>
                <td colspan="2" style="vertical-align:top;">
                    <div style="display:flex; flex-direction:column; gap:6px;">
                        ${bestandRowsHtml}
                        <div class="bestand-extra-row">
                            ${resHtml ? `<div>${resHtml}</div>` : ''}
                            <div class="bestand-verfuegbar-info" style="color:${vFarbe};">
                                ${!hatNachkauf && !hatMinus ? `Verfügbar: <strong>${vText}</strong>` : ''}
                                ${hatNachkauf ? '<div class="bestand-nachkauf-hinweis" style="color:#c0392b;">Nachkaufen</div>' : (hatMinus ? '<div class="bestand-nachkauf-hinweis" style="color:#27ae60;">Verfügbar</div>' : '')}
                            </div>
                        </div>
                    </div>
                </td>`;
            tbody.appendChild(tr);
        });
    });

    const hiddenCount = aktuelleDaten.filter(z => z.artikel && !z.artikel.wichtig).length;
    if (hiddenCount > 0 && aktiverRegalFilter === '') {
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

async function speichereMenge(bId) {
    const f = $(`menge-${bId}`);
    if (!f) return;
    const neueMenge = f.value.trim() === '-' ? -2 : werteMengeAus(f.value);
    f.value = neueMenge === -2 ? '-' : neueMenge;
    aktualisiereMengeEingabeFarbe(f);
    f.style.backgroundColor = '#fff3cd';

    const datum = new Date().toISOString();
    let { error } = await dbClient.from('bestand').update({ menge: neueMenge, alte_menge: neueMenge, created_at: datum }).eq('id', bId);
    if (error) {
        const fb = await dbClient.from('bestand').update({ menge: neueMenge, alte_menge: neueMenge }).eq('id', bId);
        error = fb.error;
    }
    if (!error) {
        f.style.backgroundColor = '#d4edda';
        showToast(`Bestand gespeichert: ${f.value}`);
        setTimeout(() => { if (f) f.style.backgroundColor = ''; ladeAlles(); }, 800);
    } else showToast('Speicherfehler!', 'error');
}

// Artikel anlegen / bearbeiten
function toggleEditMode() {
    isEditMode = !isEditMode;
    const b = $('btn-edit-mode');
    if (b) { b.innerText = isEditMode ? '✏️ Bearbeiten: AN' : '✏️ Bearbeiten: AUS'; b.style.backgroundColor = isEditMode ? '#e67e22' : '#f39c12'; }
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
    input.value = '0'; input.disabled = false;
    aktualisiereMengeEingabeFarbe(input);
    setzeBestandStatus(first, 'zahl');

    const def = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
    if (def && first.querySelector('.new-ort')) first.querySelector('.new-ort').value = def.id;
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
    const n = $('new-name').value.trim(), k = $('new-kategorie').value.trim(), e = $('new-einheit').value;
    const w = Boolean($('new-wichtig')?.checked), t = $('new-typ')?.value || 'zaehlbar';
    if (!n) return showToast('Bitte einen Namen eingeben!', 'warning');

    if (alleArtikelInfos.some(a => a.name.toLowerCase() === n.toLowerCase()) && !confirm(`Warnung: Artikel "${n}" existiert bereits. Trotzdem anlegen?`)) return;

    const { data, error } = await dbClient.from('artikel').insert([{ name: n, kategorie: k, einheit: e, wichtig: w, typ: t }]).select();
    if (error) return showToast(error.code === '23505' ? `Artikel "${n}" existiert bereits.` : 'Fehler: ' + error.message, 'error');

    const inserts = Array.from(document.querySelectorAll('#new-orte-wrapper .lagerort-row')).map(row => {
        const menge = leseBestandswertAusZeile(row);
        const oldVal = werteMengeAus(row.querySelector('.new-menge')?.getAttribute('data-old-value') || '0');
        return { artikel_id: data[0].id, lagerort_id: row.querySelector('.new-ort').value, menge, alte_menge: menge < 0 ? oldVal : menge };
    });

    await dbClient.from('bestand').insert(inserts);
    closeModal('artikelModal');
    showToast('Neuer Artikel angelegt!');
    ladeAlles();
}

function addEditOrtRow(data = null) {
    const wrapper = $('edit-orte-wrapper');
    const div = document.createElement('div');
    div.className = 'edit-ort-row';
    div.style = 'display:flex; gap:8px; margin-bottom:8px; align-items:center;';

    const def = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
    const options = alleLagerorte.map(o => `<option value="${o.id}" ${(data?.lagerort_id == o.id || (!data && def?.id == o.id)) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('');

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
        <button type="button" class="btn" style="background:#e74c3c; padding:8px 12px; width:auto;" onclick="removeEditRow(this)">🗑️</button>`;
    setzeBestandStatus(div, status, status === 'strich-warn');
    wrapper.appendChild(div);
}
function removeEditRow(btn) {
    if ($('edit-orte-wrapper').querySelectorAll('.edit-ort-row').length > 1) btn.closest('.edit-ort-row').remove();
    else showToast('Ein Artikel muss mindestens einen Lagerort haben!', 'warning');
}

async function openEditModal(artikelId) {
    if (!isEditMode) return;
    const art = alleArtikelInfos.find(a => a.id === artikelId);
    const bestaende = aktuelleDaten.filter(b => b.artikel_id === artikelId);
    $('edit-artikel-id').value = artikelId;
    $('edit-name').value = art.name;
    $('edit-kategorie').value = art.kategorie || '';
    $('edit-einheit').value = art.einheit || 'Stück';
    if ($('edit-wichtig')) $('edit-wichtig').checked = Boolean(art.wichtig);
    if ($('edit-typ')) $('edit-typ').value = art.typ || 'zaehlbar';

    const wrapper = $('edit-orte-wrapper');
    wrapper.innerHTML = '';
    if (bestaende.length) bestaende.forEach(b => addEditOrtRow(b));
    else addEditOrtRow();
    openModalById('editModal');
}

async function speichereBearbeitung() {
    const aid = $('edit-artikel-id').value, name = $('edit-name').value.trim(), kat = $('edit-kategorie').value.trim();
    const einheit = $('edit-einheit').value, wichtig = Boolean($('edit-wichtig')?.checked), typ = $('edit-typ')?.value || 'zaehlbar';

    const { error: upErr } = await dbClient.from('artikel').update({ name, kategorie: kat, einheit, wichtig, typ }).eq('id', aid);
    if (upErr) return showToast(upErr.code === '23505' ? `Name "${name}" bereits vergeben.` : 'Fehler: ' + upErr.message, 'error');

    await dbClient.from('bestand').delete().eq('artikel_id', aid);
    const inserts = Array.from(document.querySelectorAll('.edit-ort-row')).map(row => {
        const oid = row.querySelector('.edit-ort-select').value;
        const menge = leseBestandswertAusZeile(row);
        const oldVal = werteMengeAus(row.querySelector('.edit-menge-input')?.getAttribute('data-old-value') || '0');
        return { artikel_id: aid, lagerort_id: oid, menge, alte_menge: menge < 0 ? oldVal : menge };
    });
    if (inserts.length) await dbClient.from('bestand').insert(inserts);

    closeModal('editModal');
    showToast('Artikel aktualisiert!');
    ladeAlles();
}

async function artikelLoeschen() {
    if (!confirm('Diesen Artikel und alle seine Standorte wirklich komplett löschen?')) return;
    const aId = $('edit-artikel-id').value;
    await dbClient.from('bestand').delete().eq('artikel_id', aId);
    await dbClient.from('artikel').delete().eq('id', aId);
    closeModal('editModal');
    showToast('Artikel gelöscht');
    ladeAlles();
}

// Lagerorte verwalten
function openNeuOrtModal() { $('neu-ort-name').value = ''; openModalById('neuOrtModal'); }
async function speichereNeuenOrt() {
    const nOrt = $('neu-ort-name').value.trim();
    if (!nOrt) return showToast('Bitte Namen eingeben!', 'warning');
    const { error } = await dbClient.from('lagerorte').insert([{ name: nOrt }]);
    if (error) showToast('Fehler: ' + error.message, 'error');
    else { closeModal('neuOrtModal'); showToast('Neuer Ort angelegt!'); ladeAlles(); }
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
    const { error } = await dbClient.from('lagerorte').update({ name: nName }).eq('id', oId);
    if (error) showToast('Fehler: ' + error.message, 'error');
    else { closeModal('orteModal'); showToast('Lagerort umbenannt!'); ladeAlles(); }
}
async function loescheOrt() {
    const oId = $('manage-ort-select').value;
    if (aktuelleDaten.some(b => String(b.lagerort_id) === String(oId))) return showToast('Fehler: Ort ist nicht leer!', 'error');
    if (!confirm('Diesen Lagerort wirklich löschen?')) return;
    const { error } = await dbClient.from('lagerorte').delete().eq('id', oId);
    if (error) showToast('Fehler: ' + error.message, 'error');
    else { closeModal('orteModal'); showToast('Lagerort gelöscht!'); ladeAlles(); }
}
async function entferneNfcVonOrt() {
    const oId = $('manage-ort-select').value;
    if (!confirm('NFC-Tag-Zuordnung für diesen Lagerort wirklich entfernen?')) return;
    await dbClient.from('lagerorte').update({ nfc_code: null, zugewiesene_packliste_id: null, zugewiesen_am: null }).eq('id', oId);
    showToast('NFC-Zuordnung entfernt.');
    await ladeAlles();
    ortSelectChanged();
}
async function schreibeNfcTagFuerOrt() {
    const oId = $('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(oId));
    if (!ort) return showToast('Bitte zuerst Lagerort auswählen.', 'warning');
    let code = ort.nfc_code;
    if (!code) {
        const slug = String(ort.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        code = `${slug || 'ort'}-${ort.id}`;
        await dbClient.from('lagerorte').update({ nfc_code: code }).eq('id', ort.id);
        await ladeAlles();
        ortSelectChanged();
    }
    const link = new URL('https://trilager.pius-s.de'); link.searchParams.set('kistencheck', code);
    await schreibeNfcUrlTag(link.toString(), ort.name);
}

// Kommentare
function openKommentarModal(artikelId, event) {
    if (event) event.stopPropagation();
    if (!isEditMode) return;
    const art = alleArtikelInfos.find(a => String(a.id) === String(artikelId));
    if (!art) return;
    $('kommentar-artikel-id').value = artikelId;
    $('kommentar-artikel-name').innerText = art.name;
    $('kommentar-text').value = art.kommentar || '';
    openModalById('kommentarModal');
}
async function speichereKommentar() {
    const aid = $('kommentar-artikel-id').value, text = $('kommentar-text').value;
    const { error } = await dbClient.from('artikel').update({ kommentar: text }).eq('id', aid);
    if (error) showToast('Fehler: ' + error.message, 'error');
    else { closeModal('kommentarModal'); showToast('Kommentar gespeichert!'); ladeAlles(); }
}

// =========================================================================
// 6. EVENT- & PACKLISTEN-MODUS (INKL. EXCEL & DRUCK)
// =========================================================================
async function ladeEventDaten() {
    const { data: lists } = await dbClient.from('packlisten').select('*').order('name');
    packlisten = lists || [];
    populateSelect($('packlisten-auswahl'), packlisten, { defaultOption: '-- Wähle Resort / Packliste --' });
    const { data: pos } = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie, einheit)');
    packlistenPositionen = pos || [];
    zeigePackliste();
}

function zeigePackliste() {
    const currentId = $('packlisten-auswahl').value;
    const details = $('packliste-details'), tbody = $('event-tabelle');
    tbody.innerHTML = '';
    if (!currentId) { details.style.display = 'none'; return; }
    details.style.display = 'block';

    const positionen = packlistenPositionen.filter(p => String(p.packliste_id) === String(currentId));
    if (positionen.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Noch keine Gegenstände in dieser Liste.</td></tr>';
        return;
    }

    positionen.forEach(pos => {
        let name = '', avail = '-', status = '<span style="color:#7f8c8d;">- Manuell prüfen -</span>';
        if (pos.artikel_id && pos.artikel) {
            name = (pos.artikel.kategorie ? pos.artikel.kategorie + ' > ' : '') + pos.artikel.name;
            let gesamt = 0, inf = false, minus = false;
            aktuelleDaten.filter(b => b.artikel_id === pos.artikel_id).forEach(b => {
                const m = Number(b.menge);
                if (m === -1) inf = true; else if (m === -2) minus = true; else if (m >= 0) gesamt += m;
            });

            if (inf || minus) {
                avail = inf ? '∞' : '-';
                status = '<span class="event-ok">✅ OK</span>';
            } else {
                const verbrauchtAndere = packlistenPositionen.filter(p => p.artikel_id === pos.artikel_id && String(p.packliste_id) !== String(currentId))
                    .reduce((sum, p) => sum + Number(p.menge), 0);
                const frei = gesamt - verbrauchtAndere;
                avail = frei;
                status = pos.menge > frei ? `<span class="event-warning">❌ Zu wenig (${frei - pos.menge})</span>` : '<span class="event-ok">✅ OK</span>';
            }
        } else {
            name = escapeHtml(pos.eigener_name) + ' <small style="color:#999;">(Eigener Posten)</small>';
        }

        let mengeCell = pos.menge;
        if (isEventEditMode) {
            mengeCell = `<input type="text" class="menge-input" value="${pos.menge}" onchange="updatePackMenge(${pos.id}, this.value)">`;
            status += ` <button class="btn" style="background:#e74c3c; padding:4px 8px; font-size:0.8em; margin-left:10px;" onclick="loeschePackPosition(${pos.id})">🗑️</button>`;
        }
        tbody.innerHTML += `<tr><td><strong>${name}</strong></td><td>${mengeCell}</td><td>${avail}</td><td>${status}</td></tr>`;
    });
    renderEventKistenListe();
}

function toggleEventEditMode() {
    isEventEditMode = !isEventEditMode;
    const b = $('btn-event-edit');
    if (b) { b.innerText = isEventEditMode ? '✏️ Bearbeiten: AN' : '✏️ Bearbeiten: AUS'; b.style.backgroundColor = isEventEditMode ? '#e67e22' : '#f39c12'; }
    document.querySelectorAll('.event-edit-only').forEach(el => el.style.display = isEventEditMode ? '' : 'none');
    zeigePackliste();
}

function openPackItemModal() {
    if (!$('packlisten-auswahl').value) return showToast('Bitte wähle zuerst eine Packliste aus!', 'warning');
    const datalist = $('pack-artikel-datalist');
    datalist.innerHTML = '';
    $('pack-artikel-input').value = '';
    alleArtikelInfos.forEach(art => {
        datalist.innerHTML += `<option value="${escapeHtml((art.kategorie ? art.kategorie + ' > ' : '') + art.name)}">`;
    });
    openModalById('packItemModal');
    togglePackTyp();
}

function togglePackTyp() {
    const typ = $('pack-typ').value;
    $('div-pack-lager').style.display = typ === 'lager' ? 'block' : 'none';
    $('div-pack-custom').style.display = typ === 'custom' ? 'block' : 'none';
    aktualisierePackVerfuegbarkeit();
}

function aktualisierePackVerfuegbarkeit() {
    if ($('pack-typ').value !== 'lager') return;
    const val = $('pack-artikel-input').value;
    const art = alleArtikelInfos.find(a => (a.kategorie ? a.kategorie + ' > ' : '') + a.name === val);
    const info = $('pack-artikel-info');
    if (!art) { info.innerHTML = ''; return; }

    const verbleibend = holeVerbleibendeMenge(art.id);
    if (verbleibend === '∞' || verbleibend === '-') {
        info.innerHTML = `✅ Sonderartikel (Bestand nicht limitiert: ${verbleibend})`;
        info.style.color = '#27ae60';
    } else if (verbleibend > 0) {
        info.innerHTML = `✅ Noch <strong>${verbleibend}</strong> frei im Lager`;
        info.style.color = '#27ae60';
    } else {
        info.innerHTML = `⚠️ Nichts mehr frei (Genau 0)`;
        info.style.color = '#e74c3c';
    }
}

async function packPositionSpeichern() {
    const listId = $('packlisten-auswahl').value, typ = $('pack-typ').value, menge = werteMengeAus($('pack-menge').value);
    const dbObj = { packliste_id: listId, menge };

    if (typ === 'lager') {
        const val = $('pack-artikel-input').value;
        const art = alleArtikelInfos.find(a => (a.kategorie ? a.kategorie + ' > ' : '') + a.name === val);
        if (!art) return showToast('Ungültiger Artikel!', 'warning');
        dbObj.artikel_id = art.id;
    } else {
        const en = $('pack-eigener-name').value.trim();
        if (!en) return showToast('Bitte Namen eingeben!', 'warning');
        dbObj.eigener_name = en;
    }

    const { error } = await dbClient.from('packlisten_positionen').insert([dbObj]);
    if (error) showToast('Fehler: ' + error.message, 'error');
    else { closeModal('packItemModal'); showToast('Position hinzugefügt!'); ladeAlles(); }
}

async function updatePackMenge(posId, val) {
    await dbClient.from('packlisten_positionen').update({ menge: werteMengeAus(val) }).eq('id', posId);
    ladeAlles();
}
async function loeschePackPosition(posId) {
    if (confirm('Position löschen?')) { await dbClient.from('packlisten_positionen').delete().eq('id', posId); ladeAlles(); }
}
async function neuePacklisteAnlegen() {
    const n = prompt('Name der neuen Packliste:');
    if (n?.trim()) { await dbClient.from('packlisten').insert([{ name: n.trim() }]); ladeEventDaten(); }
}
async function umbenennePackliste() {
    const id = $('packlisten-auswahl').value;
    const cur = packlisten.find(p => p.id == id);
    const n = prompt('Neuer Name:', cur?.name);
    if (n?.trim() && n !== cur.name) { await dbClient.from('packlisten').update({ name: n.trim() }).eq('id', id); ladeEventDaten(); }
}
async function loeschePackliste() {
    const id = $('packlisten-auswahl').value;
    if (confirm('Packliste wirklich löschen?')) { await dbClient.from('packlisten').delete().eq('id', id); $('packlisten-auswahl').value = ''; ladeAlles(); }
}

// Einkaufsliste & Excel Export
function startEinkaufsliste() {
    autoFehlbestandListe = []; eigeneVorschlaegeListe = []; manuelleEintraegeListe = [];
    const bestandMap = {}, nachkaufSet = new Set(), bedarfMap = {}, eigeneMap = {};

    aktuelleDaten.forEach(b => {
        const m = Number(b.menge);
        if (m === -3) nachkaufSet.add(String(b.artikel_id));
        else if (m >= 0) bestandMap[b.artikel_id] = (bestandMap[b.artikel_id] || 0) + m;
    });

    packlistenPositionen.forEach(p => {
        if (p.artikel_id) bedarfMap[p.artikel_id] = (bedarfMap[p.artikel_id] || 0) + Number(p.menge);
        else if (p.eigener_name) eigeneMap[p.eigener_name] = (eigeneMap[p.eigener_name] || 0) + Number(p.menge);
    });

    alleArtikelInfos.forEach(art => {
        const bestand = nachkaufSet.has(String(art.id)) ? 0 : (bestandMap[art.id] || 0);
        const bedarf = bedarfMap[art.id] || 0;
        if (nachkaufSet.has(String(art.id))) {
            autoFehlbestandListe.push({ artikel: art.name, menge: Math.max(1, bedarf), grund: 'Nachkauf markiert' });
        } else if (bedarf > bestand) {
            autoFehlbestandListe.push({ artikel: art.name, menge: bedarf - bestand, grund: 'Fehlt im Lager' });
        }
    });

    $('auto-kauf-liste').innerHTML = autoFehlbestandListe.length ? autoFehlbestandListe.map(i => `<li>${i.menge}x ${escapeHtml(i.artikel)}</li>`).join('') : '<li style="color:#27ae60;">Alles grün! Keine Fehlbestände.</li>';
    $('eigene-kauf-liste').innerHTML = Object.entries(eigeneMap).map(([name, m], idx) => {
        eigeneVorschlaegeListe.push({ artikel: name, menge: m, grund: 'Sonderposten Packliste' });
        return `<li style="margin-bottom:6px;"><label style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="checkbox" class="eigene-kauf-check" data-index="${idx}" checked onchange="aktualisiereEinkaufslisteAuswahl()"><span>${m}x ${escapeHtml(name)}</span></label></li>`;
    }).join('') || '<li style="color:#7f8c8d;">Keine eigenen Gegenstände.</li>';

    aktualisiereEinkaufslisteAuswahl();
    $('manuell-kauf-liste').innerHTML = '';
    openModalById('kauflisteModal');
}

function aktualisiereEinkaufslisteAuswahl() {
    const ausgewaehlt = Array.from(document.querySelectorAll('.eigene-kauf-check:checked')).map(chk => eigeneVorschlaegeListe[Number(chk.dataset.index)]).filter(Boolean);
    einkaufslisteArray = [...autoFehlbestandListe, ...ausgewaehlt, ...manuelleEintraegeListe];
}

function manuellAufZettel() {
    const n = $('manuell-kauf-name').value.trim(), m = werteMengeAus($('manuell-kauf-menge').value);
    if (!n || m <= 0) return;
    manuelleEintraegeListe.push({ artikel: n, menge: m, grund: 'Manuell hinzugefügt' });
    aktualisiereEinkaufslisteAuswahl();
    $('manuell-kauf-liste').innerHTML += `<li>${m}x ${escapeHtml(n)}</li>`;
    $('manuell-kauf-name').value = ''; $('manuell-kauf-menge').value = '1';
}

async function downloadExcel() {
    if (!einkaufslisteArray.length) return showToast('Die Liste ist leer.', 'warning');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Einkaufsliste');

    ws.mergeCells('A1:C1');
    const t = ws.getCell('A1'); t.value = '📦 EINKAUFSLISTE - TRISPORT ERDING'; t.font = { size: 16, bold: true, color: { argb: 'FFE3000F' } }; t.alignment = { horizontal: 'center' };
    ws.mergeCells('A2:C2');
    const sub = ws.getCell('A2'); sub.value = 'Erstellt am: ' + new Date().toLocaleString('de-DE'); sub.alignment = { horizontal: 'center' };

    const h = ws.getRow(4); h.values = ['ARTIKEL / MATERIAL', 'MENGE', 'GRUND / HERKUNFT'];
    ['A', 'B', 'C'].forEach(c => {
        const cell = ws.getCell(`${c}4`);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3498DB' } };
    });

    einkaufslisteArray.forEach((item, i) => {
        const row = ws.getRow(5 + i);
        row.values = [item.artikel, item.menge, item.grund];
    });
    ws.getColumn(1).width = 40; ws.getColumn(2).width = 12; ws.getColumn(3).width = 30;

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `Trisport_Einkauf_${new Date().toISOString().split('T')[0]}.xlsx`;
    a.click();
    closeModal('kauflisteModal');
}

function druckePackliste() {
    const listId = $('packlisten-auswahl').value;
    if (!listId) return;
    const pl = packlisten.find(p => p.id == listId);
    const pos = packlistenPositionen.filter(p => p.packliste_id == listId);
    const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf('/') + 1);

    const gruppen = {};
    pos.forEach(p => {
        let kat = p.artikel?.kategorie || 'Ohne Kategorie', ort = '-';
        if (p.artikel_id) {
            const orte = Array.from(new Set(aktuelleDaten.filter(b => b.artikel_id === p.artikel_id && b.lagerorte?.name).map(b => b.lagerorte.name)));
            ort = orte.join(', ') || '-';
        } else { kat = 'Eigene Gegenstaende'; ort = 'Nicht im Lager'; }
        if (!gruppen[kat]) gruppen[kat] = [];
        gruppen[kat].push({ name: p.artikel?.name || p.eigener_name, menge: p.menge, ort });
    });

    const win = window.open('', '_blank');
    let rowsHtml = Object.entries(gruppen).map(([kat, items]) => `
        <tr style="background:#eef3f8; font-weight:bold;"><td colspan="4">📁 ${escapeHtml(kat)}</td></tr>
        ${items.map(i => `<tr><td style="text-align:center; width:60px;"><div style="width:24px; height:18px; border:1px solid #333; margin:auto;"></div></td><td><strong>${escapeHtml(i.name)}</strong></td><td>${i.menge}</td><td>${escapeHtml(i.ort)}</td></tr>`).join('')}
    `).join('');

    win.document.write(`
        <html><head><title>Packliste: ${escapeHtml(pl.name)}</title><style>
            body { font-family:sans-serif; padding:16px; color:#333; }
            table { width:100%; border-collapse:collapse; margin-top:10px; }
            th, td { border:1px solid #ddd; padding:8px; text-align:left; }
            th { background:#f2f2f2; }
            @media print { .no-print { display:none; } }
        </style></head><body>
            <button class="no-print" onclick="window.print()" style="padding:10px; margin-bottom:15px; cursor:pointer;">🖨️ Jetzt drucken</button>
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #e3000f; padding-bottom:10px;">
                <div><h1 style="color:#e3000f; margin:0;">📦 Packliste: ${escapeHtml(pl.name)}</h1><p style="margin:4px 0 0; color:#666;">Datum: ${new Date().toLocaleDateString('de-DE')}</p></div>
                <img src="${baseUrl}trisportlogo.jpg" style="height:55px;" alt="Logo">
            </div>
            <table><thead><tr><th>Gepackt</th><th>Gegenstand</th><th>Menge</th><th>Lagerort</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        </body></html>`);
    win.document.close();
}

// =========================================================================
// 7. KISTEN- & LAGERORT-CHECK MODUS
// =========================================================================
function gibNfcOrte() { return alleLagerorte.filter(o => o.nfc_code); }
function gibKistenBestand(lid) { return aktuelleDaten.filter(z => String(z.lagerort_id) === String(lid)).sort((a, b) => (a.artikel?.name || '').localeCompare(b.artikel?.name || '', 'de')); }

function renderKistenListe() {
    const ziel = $('kisten-tabelle');
    if (!ziel) return;
    const nfcOrte = gibNfcOrte();
    if (!nfcOrte.length) {
        ziel.innerHTML = '<tr><td colspan="4" style="padding:20px; text-align:center; color:#7f8c8d;">Noch keine Lagerorte mit NFC-Tag. In "Lagerorte verwalten" NFC-Tag beschreiben.</td></tr>';
        return;
    }

    const filter = ($('kisten-such-filter')?.value || '').toLowerCase().trim();
    ziel.innerHTML = nfcOrte.filter(o => !filter || o.name.toLowerCase().includes(filter) || String(o.nfc_code).toLowerCase().includes(filter))
        .map(o => {
            const bestand = gibKistenBestand(o.id);
            const pl = o.zugewiesene_packliste_id ? packlisten.find(p => String(p.id) === String(o.zugewiesene_packliste_id)) : null;
            const nachkauf = bestand.filter(z => Number(z.menge) === BESTAND_STRICH_NACHKAUF).length;
            return `<tr>
                <td><strong>${escapeHtml(o.name)}</strong><br><span style="font-family:monospace; color:#7f8c8d; font-size:0.85em;">${escapeHtml(o.nfc_code)}</span>${pl ? `<br><span style="color:#8e44ad;">📦 Event: ${escapeHtml(pl.name)}</span>` : ''}</td>
                <td>${bestand.length} Position(en)</td>
                <td>${nachkauf > 0 ? `<span style="color:#c0392b;">🔴 ${nachkauf}x Nachkauf</span>` : '<span style="color:#27ae60;">✔️ Alles da</span>'}</td>
                <td style="white-space:nowrap;">
                    <button class="btn" style="background:#16a085; padding:8px 10px; width:auto;" onclick="oeffneKistenCheck(${o.id})">📦 Inhalt / Prüfen</button>
                    <button class="btn" style="background:#3498db; padding:8px 10px; width:auto;" onclick="openOrteVerwalten(${o.id})">⚙️ Verwalten</button>
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="4" style="padding:20px; text-align:center;">Kein Ort passt zum Filter.</td></tr>';
}

async function verarbeiteOrtScan(rawCode) {
    if (scanSperre.kisten) return;
    scanSperre.kisten = true;
    setTimeout(() => scanSperre.kisten = false, 1500);

    const code = extrahiereOrtCodeAusScan(rawCode) || String(rawCode || '').trim();
    const ort = alleLagerorte.find(o => o.nfc_code && o.nfc_code.toLowerCase() === code.toLowerCase());
    if (!ort) {
        if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
        return showToast(`Kein Lagerort mit NFC-Code "${code}" gefunden.`, 'error');
    }

    if (navigator.vibrate) navigator.vibrate(120);
    schliesseKistenKameraModal();
    if (kistenScanAktion === 'zuweisen') await weiseKisteAktuellemEventZu(ort.id);
    else oeffneKistenCheck(ort.id);
}

function oeffneKistenCheck(lid) {
    const ort = alleLagerorte.find(o => String(o.id) === String(lid));
    if (!ort) return;
    kistenCheckAktuelleId = lid;
    $('kisten-check-titel').innerText = `📦 Inhalt / Prüfen: ${ort.name}`;
    $('kisten-check-code').innerText = ort.nfc_code ? `NFC-Code: ${ort.nfc_code}` : '';

    const datalist = $('kategorie-artikel-liste');
    if (datalist) datalist.innerHTML = alleArtikelInfos.map(a => `<option value="${escapeHtml(a.name)}">`).join('');

    const wrapper = $('kisten-check-liste');
    wrapper.innerHTML = '';
    const bestand = gibKistenBestand(lid);
    if (!bestand.length) wrapper.innerHTML = '<p style="color:#7f8c8d; font-size:0.9em;">Noch keine Artikel an diesem Lagerort.</p>';
    else bestand.forEach(z => fuegeKistenBestandZeileHinzu(z));
    openModalById('kistenCheckModal');
}

function fuegeKistenBestandZeileHinzu(data = null) {
    const wrapper = $('kisten-check-liste');
    wrapper.querySelector('p')?.remove();
    const div = document.createElement('div');
    div.className = 'edit-ort-row';
    div.dataset.bestandId = data?.id || '';
    div.dataset.artikelId = data?.artikel_id ?? data?.artikel?.id ?? '';

    let displayVal = '1', status = 'zahl';
    if (data?.id) {
        if (data.menge == -1) { displayVal = '∞'; status = 'inf'; }
        else if (data.menge == -2) { displayVal = '-'; status = 'strich-ok'; }
        else if (data.menge == -3) { displayVal = '-'; status = 'strich-warn'; }
        else displayVal = data.menge;
    }

    div.innerHTML = `
        <div class="bestand-row-stack" style="width:100%;">
            <div style="font-weight:bold; padding:4px 2px;">${escapeHtml(data?.artikel?.name || 'Unbekannt')}</div>
            <div class="bestand-action-row" style="flex-wrap:nowrap; width:100%;">
                <input type="text" class="edit-menge-input bestand-menge-input bestand-form-quantity" value="${displayVal}" data-old-value="${data?.alte_menge ?? 1}" oninput="bestandEingabeGeaendert(this)" style="flex:1.25; min-width:0; padding:12px; border-radius:6px; border:1px solid #ccc; text-align:center;">
                <button type="button" class="btn bestand-mode-btn bestand-btn-inf" style="background:#95a5a6; padding:10px; width:auto; min-width:68px; font-weight:bold;" onclick="toggleBestandInf(this)">∞</button>
                <button type="button" class="btn bestand-mode-btn bestand-btn-minus" style="background:#95a5a6; padding:10px; width:auto; min-width:44px; font-weight:bold;" onclick="toggleBestandMinus(this)">-</button>
            </div>
            <label class="bestand-nachkauf-wrap"><input type="checkbox" class="bestand-nachkauf-checkbox" onchange="toggleNachkaufCheckbox(this)"><span>Auf Nachkaufen setzen (🔴 Nachfüllen nötig)</span></label>
        </div>
        <button type="button" class="btn" style="background:#e74c3c; padding:8px 12px; width:auto;" onclick="entferneKistenBestandZeile(this)">🗑️</button>`;
    setzeBestandStatus(div, status, status === 'strich-warn');
    wrapper.appendChild(div);
}

function kistenCheckArtikelHinzufuegen() {
    const inp = $('kisten-check-artikel-input');
    const val = inp.value.trim();
    if (!val) return;
    const art = alleArtikelInfos.find(a => a.name.toLowerCase() === val.toLowerCase());
    if (!art) return showToast(`Artikel "${val}" nicht gefunden.`, 'error');
    if ($(`#kisten-check-liste .edit-ort-row[data-artikel-id="${art.id}"]`)) return showToast('Bereits vorhanden.', 'warning');
    fuegeKistenBestandZeileHinzu({ artikel_id: art.id, artikel: { name: art.name } });
    inp.value = '';
}

async function entferneKistenBestandZeile(btn) {
    const row = btn.closest('.edit-ort-row');
    if (row?.dataset.bestandId) await dbClient.from('bestand').delete().eq('id', row.dataset.bestandId);
    row.remove();
}

async function speichereKistenCheck() {
    if (!kistenCheckAktuelleId) return closeModal('kistenCheckModal');
    const jetzt = new Date().toISOString(), user = holeLokaleSession()?.username || 'Unbekannt';
    const rows = Array.from(document.querySelectorAll('#kisten-check-liste .edit-ort-row'));

    const tasks = rows.map(row => {
        const aid = row.dataset.artikelId, bid = row.dataset.bestandId;
        const menge = leseBestandswertAusZeile(row);
        const oldVal = werteMengeAus(row.querySelector('input')?.getAttribute('data-old-value') || '0');
        const payload = { menge, alte_menge: menge < 0 ? oldVal : menge, geprueft_am: jetzt, geprueft_von: user };
        return bid ? dbClient.from('bestand').update(payload).eq('id', bid) : dbClient.from('bestand').insert([{ artikel_id: Number(aid), lagerort_id: Number(kistenCheckAktuelleId), ...payload }]);
    });

    await Promise.all(tasks);
    showToast('✅ Inhalt gespeichert!');
    closeModal('kistenCheckModal');
    await ladeAlles();
    renderKistenListe();
}

// Event-Zuweisung
async function weiseKisteAktuellemEventZu(lid) {
    const pid = $('packlisten-auswahl')?.value;
    if (!pid) return showToast('Kein Event ausgewählt.', 'error');
    await dbClient.from('lagerorte').update({ zugewiesene_packliste_id: Number(pid), zugewiesen_am: new Date().toISOString() }).eq('id', lid);
    showToast('📦 Kiste zugeordnet.');
    await ladeAlles();
    renderKistenListe();
    renderEventKistenListe();
}
async function entferneKisteVonEvent(lid) {
    await dbClient.from('lagerorte').update({ zugewiesene_packliste_id: null, zugewiesen_am: null }).eq('id', lid);
    showToast('Kiste freigegeben.');
    await ladeAlles();
    renderKistenListe();
    renderEventKistenListe();
}
function eventKisteManuellZuweisen() {
    const s = $('event-kiste-manuell-auswahl');
    if (s?.value) { weiseKisteAktuellemEventZu(s.value); s.value = ''; }
}
function renderEventKistenListe() {
    const ziel = $('event-kisten-liste'), select = $('event-kiste-manuell-auswahl'), pid = $('packlisten-auswahl')?.value;
    if (!ziel || !pid) return;
    const zugeordnet = gibNfcOrte().filter(o => String(o.zugewiesene_packliste_id) === String(pid));
    ziel.innerHTML = zugeordnet.map(o => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; border:1px solid #eee; border-radius:8px; margin-bottom:6px;">
            <div><strong>${escapeHtml(o.name)}</strong> <span style="color:#7f8c8d; font-size:0.85em;">(${escapeHtml(o.nfc_code)})</span></div>
            <div style="display:flex; gap:6px;">
                <button class="btn" style="background:#16a085; padding:6px 10px; width:auto;" onclick="oeffneKistenCheck(${o.id})">📦 Prüfen</button>
                <button class="btn" style="background:#c0392b; padding:6px 10px; width:auto;" onclick="entferneKisteVonEvent(${o.id})">Lösen</button>
            </div>
        </div>`).join('') || '<p style="color:#7f8c8d; font-size:0.9em;">Diesem Event ist noch keine Kiste zugeordnet.</p>';

    if (select) {
        populateSelect(select, gibNfcOrte().filter(o => !o.zugewiesene_packliste_id), { defaultOption: '-- Kiste manuell zuweisen --', formatLabel: o => `${o.name} (${o.nfc_code})` });
    }
}

// =========================================================================
// 8. ENTNAHME-PROTOKOLL & WIZARD
// =========================================================================
function holeVerbleibendeMenge(artikelId, ignoriereWizardIndex = -1) {
    const bestaende = aktuelleDaten.filter(b => String(b.artikel_id) === String(artikelId));
    const maxVerfuegbar = berechneArtikelVerfuegbarkeit(artikelId, bestaende);
    if (maxVerfuegbar === '∞' || maxVerfuegbar === '-') return maxVerfuegbar;

    let wizardMenge = 0;
    entnahmeMaterialien.forEach((item, idx) => {
        if (String(item.artikel_id) === String(artikelId) && idx !== ignoriereWizardIndex) wizardMenge += Number(item.menge) || 0;
    });
    return Math.max(0, Number(maxVerfuegbar) - wizardMenge);
}

function berechneArtikelVerfuegbarkeit(artId, bestaende = []) {
    let gesamt = 0, inf = false, strich = false;
    bestaende.forEach(b => {
        const m = Number(b.menge);
        if (m === -1) inf = true; else if (m === -2) strich = true; else if (m >= 0) gesamt += m;
    });
    if (inf) return '∞';
    if (strich && gesamt === 0) return '-';
    return Math.max(0, gesamt - Number(entnahmeVerbrauchProArtikel[String(artId)] || 0));
}

async function ladeAktuelleEntnahmeVerbraeuche() {
    const { data } = await dbClient.from(TABLES.ENTNAHME).select('materialien');
    const vMap = {};
    (data || []).forEach(e => {
        (Array.isArray(e.materialien) ? e.materialien : []).forEach(m => {
            if (m?.artikel_id && Number(m.menge) > 0) vMap[String(m.artikel_id)] = (vMap[String(m.artikel_id)] || 0) + Number(m.menge);
        });
    });
    entnahmeVerbrauchProArtikel = vMap;
}

function entnahmeWizardZuSchritt(step) {
    entnahmeWizardStep = Math.min(3, Math.max(1, Number(step) || 1));
    document.querySelectorAll('[data-entnahme-step-panel]').forEach(p => p.style.display = Number(p.getAttribute('data-entnahme-step-panel')) === entnahmeWizardStep ? 'block' : 'none');
    document.querySelectorAll('[data-entnahme-step-indicator]').forEach(b => {
        const s = Number(b.getAttribute('data-entnahme-step-indicator'));
        b.classList.toggle('active', s === entnahmeWizardStep);
        b.classList.toggle('complete', s < entnahmeWizardStep);
    });
    entnahmeAktualisiereZusammenfassung();
    entnahmeSpeichereDraftLokal();
}
function entnahmeWizardZurueck() { entnahmeWizardZuSchritt(entnahmeWizardStep - 1); }
function entnahmeWizardWeiter() { entnahmeWizardZuSchritt(entnahmeWizardStep + 1); }

function entnahmeAktualisiereZusammenfassung() {
    const u = entnahmeBenutzerVorlagen.find(i => String(i.id) === String(entnahmeAuswahlBenutzerId));
    const s = entnahmeSammelvorlagen.find(i => String(i.id) === String(entnahmeAuswahlSammelId));
    if ($('entnahme-summary-benutzer')) $('entnahme-summary-benutzer').textContent = u?.name || $('entnahme-name')?.value.trim() || 'Noch kein Benutzer';
    if ($('entnahme-summary-sammel')) $('entnahme-summary-sammel').textContent = s?.name || $('entnahme-sammelvorlagenname')?.value.trim() || 'Noch keine Vorlage';
    if ($('entnahme-summary-materialien')) $('entnahme-summary-materialien').textContent = entnahmeMaterialien.length ? `${entnahmeMaterialien.length} Positionen` : 'Noch keine Materialien';
}

function renderEntnahmeMaterialien() {
    const rows = entnahmeMaterialien.length ? entnahmeMaterialien.map((item, idx) => `
        <tr>
            <td><strong>${escapeHtml(item.label)}</strong><br><small style="color:#666;">${escapeHtml(item.einheit || 'Stück')}</small></td>
            <td style="width:120px;"><input type="text" value="${escapeHtml(item.menge)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; text-align:center;" onchange="entnahmeMaterialMengeAendern(${idx}, this.value)"></td>
            <td style="width:70px; text-align:right;"><button class="btn" style="background:#e74c3c; padding:8px 10px; width:auto;" onclick="entnahmeMaterialLoeschen(${idx})">🗑️</button></td>
        </tr>`).join('') : '<tr><td colspan="3" style="text-align:center; color:#666; padding:18px;">Noch keine Materialien ausgewählt.</td></tr>';
    document.querySelectorAll('.entnahme-material-liste-target').forEach(t => t.innerHTML = rows);
}

function entnahmeMaterialHinzufuegen(inpId = 'entnahme-artikel-input', mengeId = 'entnahme-artikel-menge') {
    const inp = $(inpId), mInp = $(mengeId);
    if (!inp || !mInp) return;
    const label = inp.value.trim();
    const art = alleArtikelInfos.find(i => ((i.kategorie ? i.kategorie + ' > ' : '') + i.name) === label);
    if (!art) return showToast('Artikel aus der Liste auswählen!', 'warning');
    const menge = werteMengeAus(mInp.value);
    if (menge <= 0) return showToast('Menge größer 0 eingeben.', 'warning');

    const frei = holeVerbleibendeMenge(art.id);
    if (!['∞', '-'].includes(frei) && menge > frei) return showToast(`Fehler: Nur noch ${frei} verfügbar!`, 'error');

    const exist = entnahmeMaterialien.find(i => String(i.artikel_id) === String(art.id));
    if (exist) exist.menge += menge;
    else entnahmeMaterialien.push({ artikel_id: art.id, label, kategorie: art.kategorie || '', einheit: art.einheit || 'Stück', menge });

    inp.value = ''; mInp.value = '1';
    renderEntnahmeMaterialien();
    entnahmeMarkiereAutoSaveAlsErforderlich();
}

function entnahmeModalMaterialHinzufuegen() { entnahmeMaterialHinzufuegen('entnahme-modal-artikel-input', 'entnahme-modal-artikel-menge'); }

function entnahmeMaterialMengeAendern(idx, val) {
    if (!entnahmeMaterialien[idx]) return;
    let m = werteMengeAus(val);
    if (m <= 0) entnahmeMaterialien.splice(idx, 1);
    else {
        const frei = holeVerbleibendeMenge(entnahmeMaterialien[idx].artikel_id, idx);
        if (!['∞', '-'].includes(frei) && m > frei) {
            showToast(`Maximal ${frei} verfügbar!`, 'warning');
            m = frei;
        }
        entnahmeMaterialien[idx].menge = m;
    }
    renderEntnahmeMaterialien();
    entnahmeMarkiereAutoSaveAlsErforderlich();
}
function entnahmeMaterialLoeschen(idx) { entnahmeMaterialien.splice(idx, 1); renderEntnahmeMaterialien(); entnahmeMarkiereAutoSaveAlsErforderlich(); }

function entnahmeMarkiereAutoSaveAlsErforderlich({ sammelAutoSave = false } = {}) {
    if (entnahmeMarkiereTimer) clearTimeout(entnahmeMarkiereTimer);
    entnahmeMarkiereTimer = setTimeout(() => {
        entnahmeSpeichereDraftLokal();
        entnahmeAktualisiereZusammenfassung();
    }, 200);
}

function entnahmeSpeichereDraftLokal() {
    try {
        const st = {
            step: entnahmeWizardStep, benutzerVorlageId: entnahmeAuswahlBenutzerId, sammelVorlageId: entnahmeAuswahlSammelId,
            name: $('entnahme-name')?.value.trim() || '', kontakt: $('entnahme-kontakt')?.value.trim() || '', materialien: entnahmeMaterialien
        };
        window.localStorage.setItem(STORAGE_KEYS.ENTNAHME_DRAFT, JSON.stringify(st));
    } catch {}
}
function entnahmeLadeDraftLokal() { try { return JSON.parse(window.localStorage.getItem(STORAGE_KEYS.ENTNAHME_DRAFT)); } catch { return null; } }
function entnahmeLoescheDraftLokal() { window.localStorage.removeItem(STORAGE_KEYS.ENTNAHME_DRAFT); }

async function verarbeiteAusbuchenScan(rawCode) {
    if (scanSperre.ausbuchen) return;
    const aid = extrahiereArtikelIdAusScan(rawCode);
    if (!aid) return showToast('Unbekannter Code.', 'error');
    scanSperre.ausbuchen = true;
    setTimeout(() => scanSperre.ausbuchen = false, 2000);

    const art = alleArtikelInfos.find(a => String(a.id) === String(aid));
    if (!art) return showToast('Artikel nicht gefunden.', 'error');

    const frei = holeVerbleibendeMenge(aid);
    if (!['∞', '-'].includes(frei) && frei <= 0) return showToast('Alles ausgebucht!', 'error');

    const exist = entnahmeMaterialien.find(i => String(i.artikel_id) === String(aid));
    if (exist) exist.menge += 1;
    else entnahmeMaterialien.push({ artikel_id: art.id, label: art.name, kategorie: art.kategorie || '', einheit: art.einheit || 'Stück', menge: 1 });

    renderEntnahmeMaterialien();
    entnahmeMarkiereAutoSaveAlsErforderlich();
    if (navigator.vibrate) navigator.vibrate(200);
    showToast(`✅ 1x ${art.name} hinzugefügt!`);
}

async function verarbeiteRueckgabeScan(rawCode) {
    if (scanSperre.rueckgabe) return;
    const aid = extrahiereArtikelIdAusScan(rawCode);
    if (!aid) return showToast('Unbekannter Code.', 'error');
    scanSperre.rueckgabe = true;
    setTimeout(() => scanSperre.rueckgabe = false, 2000);

    try {
        const { data: art } = await dbClient.from('artikel').select('name').eq('id', aid).single();
        const aName = art?.name || 'Artikel ' + aid;
        const { data: entnahmen } = await dbClient.from(TABLES.ENTNAHME).select('*').order('created_at', { ascending: true });

        let matchE = null, mIdx = -1;
        for (const e of (entnahmen || [])) {
            const mats = Array.isArray(e.materialien) ? e.materialien : [];
            const idx = mats.findIndex(m => String(m.artikel_id) === String(aid) && Number(m.menge) > 0);
            if (idx !== -1) { matchE = e; mIdx = idx; break; }
        }

        if (!matchE) return showToast('Artikel ist bereits vollzählig im Lager!', 'warning');

        const neueMats = [...matchE.materialien];
        neueMats[mIdx].menge -= 1;
        const istLeer = neueMats[mIdx].menge <= 0;
        if (istLeer) neueMats.splice(mIdx, 1);

        const audit = { entnahme_id: String(matchE.id), name: matchE.name, kontakt: matchE.kontakt, ereignis: neueMats.length ? 'teilrueckgabe' : 'rueckgabe' };

        if (!neueMats.length) await dbClient.from(TABLES.ENTNAHME).delete().eq('id', matchE.id);
        else await dbClient.from(TABLES.ENTNAHME).update({ materialien: neueMats }).eq('id', matchE.id);

        await dbClient.from(TABLES.AUDIT).insert([{ ...audit, materialien: [{ artikel_id: aid, label: aName, menge: 1 }] }]);
        if (navigator.vibrate) navigator.vibrate(200);
        showToast(`✅ 1x ${aName} zurückgebucht!`);
        await ladeAlles();
        await ladeEntnahmeHistorie();
    } catch (e) { showToast('Fehler bei Rückgabe: ' + e.message, 'error'); }
}

async function entnahmeProtokollSpeichern() {
    const name = $('entnahme-name')?.value.trim();
    if (!name || !entnahmeMaterialien.length) return showToast('Name und mindestens 1 Material erforderlich!', 'warning');

    const payload = {
        name, kontakt: $('entnahme-kontakt')?.value.trim() || '',
        materialien: entnahmeMaterialien, benutzer_vorlage_id: entnahmeAuswahlBenutzerId || null,
        sammelvorlage_id: entnahmeAuswahlSammelId?.startsWith('pack:') ? null : (entnahmeAuswahlSammelId || null)
    };

    const { data, error } = await dbClient.from(TABLES.ENTNAHME).insert([payload]).select();
    if (error) return showToast('Fehler: ' + error.message, 'error');

    await dbClient.from(TABLES.AUDIT).insert([{ ...payload, entnahme_id: data?.[0]?.id, ereignis: 'entnahme' }]);
    showToast('Entnahme erfolgreich abgeschlossen!');
    entnahmeLoescheDraftLokal();
    entnahmeFormularZuruecksetzen();
    await ladeAlles();
    await ladeEntnahmeHistorie();
}

function entnahmeAbschliessen() { return entnahmeProtokollSpeichern(); }

function entnahmeFormularZuruecksetzen() {
    if ($('entnahme-name')) $('entnahme-name').value = '';
    if ($('entnahme-kontakt')) $('entnahme-kontakt').value = '';
    entnahmeMaterialien = []; entnahmeAuswahlBenutzerId = ''; entnahmeAuswahlSammelId = '';
    renderEntnahmeMaterialien();
    entnahmeWizardZuSchritt(1);
}

// Vorlagen Overlay & CRUD
function oeffneVorlagenOverlay() { entnahmeVorlagenBearbeiten = true; fillEntnahmeVorlagenDropdowns(); openModalById('vorlagenModal'); }
function schliesseVorlagenOverlay() { closeModal('vorlagenModal'); entnahmeVorlagenBearbeiten = false; }

function fillEntnahmeVorlagenDropdowns() {
    populateSelect($('entnahme-benutzer-vorlage'), entnahmeBenutzerVorlagen, { defaultOption: '-- Benutzer auswählen --' });
    populateSelect($('entnahme-benutzer-vorlage-bearbeiten'), entnahmeBenutzerVorlagen, { defaultOption: '-- Neuer Benutzer --' });

    const sSelect = $('entnahme-sammelvorlage');
    if (sSelect) {
        populateSelect(sSelect, entnahmeSammelvorlagen, { defaultOption: '-- Keine Vorlage --' });
        if (packlisten.length) {
            sSelect.add(new Option('──────── Packlisten ────────', '', undefined, true));
            packlisten.forEach(p => sSelect.add(new Option('Packliste: ' + p.name, 'pack:' + p.id)));
        }
    }
    populateSelect($('entnahme-sammelvorlage-bearbeiten'), entnahmeSammelvorlagen, { defaultOption: '-- Vorlage bearbeiten --' });
}

async function ladeEntnahmeVorlagen() {
    const [bRes, sRes] = await Promise.all([dbClient.from(TABLES.BENUTZER_VORLAGEN).select('*').order('name'), dbClient.from(TABLES.SAMMEL_VORLAGEN).select('*').order('name')]);
    entnahmeBenutzerVorlagen = bRes.data || [];
    entnahmeSammelvorlagen = sRes.data || [];
    fillEntnahmeVorlagenDropdowns();
}

function entnahmeBenutzerVorlageAuswaehlen() {
    const id = $('entnahme-benutzer-vorlage')?.value;
    entnahmeAuswahlBenutzerId = id;
    const u = entnahmeBenutzerVorlagen.find(i => String(i.id) === String(id));
    if ($('entnahme-name')) $('entnahme-name').value = u?.name || '';
    if ($('entnahme-kontakt')) $('entnahme-kontakt').value = u?.kontakt || '';
    entnahmeAktualisiereZusammenfassung();
    if (id) setTimeout(() => entnahmeWizardZuSchritt(2), 180);
}

function entnahmeSammelvorlageAuswaehlen() {
    const val = $('entnahme-sammelvorlage')?.value;
    entnahmeAuswahlSammelId = val;
    if (val?.startsWith('pack:')) {
        const pid = val.split(':')[1];
        const pos = packlistenPositionen.filter(p => String(p.packliste_id) === String(pid));
        entnahmeMaterialien = pos.map(p => ({ artikel_id: p.artikel_id, label: p.artikel?.name || p.eigener_name, menge: Number(p.menge) || 0 }));
    } else {
        const s = entnahmeSammelvorlagen.find(i => String(i.id) === String(val));
        entnahmeMaterialien = s?.materialien ? JSON.parse(JSON.stringify(s.materialien)) : [];
    }
    renderEntnahmeMaterialien();
    entnahmeAktualisiereZusammenfassung();
    if (val) setTimeout(() => entnahmeWizardZuSchritt(3), 180);
}

function entnahmeBenutzerVorlageNeu() { entnahmeAuswahlBenutzerId = ''; $('entnahme-name').value = ''; $('entnahme-kontakt').value = ''; }
function entnahmeSammelvorlageNeu() { entnahmeAuswahlSammelId = ''; $('entnahme-sammelvorlagenname').value = ''; entnahmeMaterialien = []; renderEntnahmeMaterialien(); }

async function entnahmeBenutzerVorlageSpeichern() {
    const name = $('entnahme-name')?.value.trim(), kontakt = $('entnahme-kontakt')?.value.trim() || '';
    if (!name) return showToast('Name eingeben!', 'warning');
    const id = entnahmeAuswahlBenutzerId;
    const res = id ? await dbClient.from(TABLES.BENUTZER_VORLAGEN).update({ name, kontakt }).eq('id', id) : await dbClient.from(TABLES.BENUTZER_VORLAGEN).insert([{ name, kontakt }]);
    if (res.error) showToast('Fehler beim Speichern.', 'error');
    else { showToast('Benutzer-Vorlage gespeichert!'); await ladeEntnahmeVorlagen(); }
}
async function entnahmeBenutzerVorlageLoeschen() {
    if (!entnahmeAuswahlBenutzerId || !confirm('Vorlage löschen?')) return;
    await dbClient.from(TABLES.BENUTZER_VORLAGEN).delete().eq('id', entnahmeAuswahlBenutzerId);
    showToast('Gelöscht.'); await ladeEntnahmeVorlagen(); entnahmeBenutzerVorlageNeu();
}
async function entnahmeSammelvorlageSpeichern() {
    const name = $('entnahme-sammelvorlagenname')?.value.trim();
    if (!name || !entnahmeMaterialien.length) return showToast('Name & Materialien erforderlich!', 'warning');
    const id = entnahmeAuswahlSammelId?.startsWith('pack:') ? '' : entnahmeAuswahlSammelId;
    const payload = { name, materialien: entnahmeMaterialien };
    const res = id ? await dbClient.from(TABLES.SAMMEL_VORLAGEN).update(payload).eq('id', id) : await dbClient.from(TABLES.SAMMEL_VORLAGEN).insert([payload]);
    if (res.error) showToast('Fehler: ' + res.error.message, 'error');
    else { showToast('Sammel-Vorlage gespeichert!'); await ladeEntnahmeVorlagen(); }
}
async function entnahmeSammelvorlageLoeschen() {
    if (!entnahmeAuswahlSammelId || !confirm('Sammel-Vorlage löschen?')) return;
    await dbClient.from(TABLES.SAMMEL_VORLAGEN).delete().eq('id', entnahmeAuswahlSammelId);
    showToast('Gelöscht.'); await ladeEntnahmeVorlagen(); entnahmeSammelvorlageNeu();
}

// Entnahme Historie & Rückgabe-Log
async function ladeEntnahmeHistorie() {
    const { data } = await dbClient.from(TABLES.ENTNAHME).select('*').order('created_at', { ascending: false }).limit(50);
    entnahmeHistorie = data || [];
    renderEntnahmeHistorie();
}
function renderEntnahmeHistorie() {
    const c = $('entnahme-historie-liste');
    if (!c) return;
    c.innerHTML = entnahmeHistorie.map(e => `
        <details class="entnahme-history-item" ${entnahmeHistorieGeoeffnet.has(String(e.id)) ? 'open' : ''} ontoggle="entnahmeHistorieGeoeffnet.${this?.open ? 'add' : 'delete'}('${e.id}')">
            <summary>
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <span>${escapeHtml(e.name)}</span>
                    <small style="color:#5f6b77;">${new Date(e.created_at).toLocaleDateString('de-DE')} · ${(e.materialien || []).length} Positionen</small>
                </div>
            </summary>
            <div class="entnahme-history-materials">
                ${(e.materialien || []).map((m, idx) => `
                    <div class="entnahme-return-row" data-index="${idx}" data-max-qty="${m.menge}">
                        <span>• ${m.menge}x ${escapeHtml(m.label)}</span>
                        <div class="entnahme-return-stepper">
                            <button onclick="entnahmeRueckgabeMengeAendern('${e.id}', ${idx}, -1)">−</button>
                            <input type="text" data-role="return-qty" value="${m.menge}" readonly>
                            <button onclick="entnahmeRueckgabeMengeAendern('${e.id}', ${idx}, 1)">+</button>
                        </div>
                    </div>`).join('')}
                <div class="entnahme-history-actions">
                    <button class="btn" style="background:#1f5f8b;" onclick="entnahmeHistorieLaden('${e.id}')">Laden</button>
                    <button class="btn" style="background:#34495e;" onclick="entnahmeTeilRueckgabeSpeichern('${e.id}')">Teilrückgabe speichern</button>
                    <button class="btn" style="background:#c0392b;" onclick="entnahmeKomplettZurueckgeben('${e.id}')">Komplett zurückgeben</button>
                </div>
            </div>
        </details>`).join('') || '<p style="color:#666;">Keine offenen Entnahmen.</p>';
}

function entnahmeRueckgabeMengeAendern(eid, idx, delta) {
    const row = document.querySelector(`details[ontoggle*="${eid}"] .entnahme-return-row[data-index="${idx}"]`);
    const inp = row?.querySelector('[data-role="return-qty"]');
    if (!inp) return;
    const max = Number(row.dataset.maxQty) || 0;
    inp.value = Math.min(max, Math.max(0, Number(inp.value) + delta));
}
async function entnahmeKomplettZurueckgeben(eid) {
    if (!confirm('Komplett zurückgeben?')) return;
    const e = entnahmeHistorie.find(i => String(i.id) === String(eid));
    await dbClient.from(TABLES.ENTNAHME).delete().eq('id', eid);
    await dbClient.from(TABLES.AUDIT).insert([{ entnahme_id: eid, name: e?.name, materialien: e?.materialien, ereignis: 'rueckgabe' }]);
    showToast('Zurückgegeben.'); await ladeAlles(); await ladeEntnahmeHistorie();
}
async function entnahmeTeilRueckgabeSpeichern(eid) {
    const e = entnahmeHistorie.find(i => String(i.id) === String(eid));
    if (!e) return;
    const rows = document.querySelectorAll(`details[ontoggle*="${eid}"] .entnahme-return-row`);
    const neueMats = [];
    rows.forEach(r => {
        const idx = Number(r.dataset.index);
        const qty = Number(r.querySelector('[data-role="return-qty"]')?.value) || 0;
        if (qty > 0 && e.materialien[idx]) neueMats.push({ ...e.materialien[idx], menge: qty });
    });
    if (!neueMats.length) return entnahmeKomplettZurueckgeben(eid);
    await dbClient.from(TABLES.ENTNAHME).update({ materialien: neueMats }).eq('id', eid);
    showToast('Teilrückgabe gespeichert.'); await ladeAlles(); await ladeEntnahmeHistorie();
}
function entnahmeHistorieLaden(eid) {
    const e = entnahmeHistorie.find(i => String(i.id) === String(eid));
    if (!e) return;
    $('entnahme-name').value = e.name || ''; $('entnahme-kontakt').value = e.kontakt || '';
    entnahmeMaterialien = JSON.parse(JSON.stringify(e.materialien || []));
    renderEntnahmeMaterialien(); entnahmeWizardZuSchritt(3);
}

async function oeffneEntnahmeLog() { openModalById('entnahmeLogModal'); await ladeEntnahmeLog(); }
function schliesseEntnahmeLog() { closeModal('entnahmeLogModal'); }
async function ladeEntnahmeLog() {
    const { data } = await dbClient.from(TABLES.AUDIT).select('*').in('ereignis', ['rueckgabe', 'teilrueckgabe']).order('created_at', { ascending: false }).limit(200);
    $('entnahme-log-liste').innerHTML = (data || []).map(e => `
        <div style="border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px;">
            <strong>${escapeHtml(e.name)}</strong> · <small>${new Date(e.created_at).toLocaleString('de-DE')}</small>
            <div>${e.ereignis === 'rueckgabe' ? '✅ Vollständig zurück' : '↩️ Teilrückgabe'}</div>
            <ul style="margin:4px 0 0; padding-left:18px;">${(e.materialien || []).map(m => `<li>${m.menge}x ${escapeHtml(m.label)}</li>`).join('')}</ul>
        </div>`).join('') || '<p style="color:#666;">Noch keine Rückgaben protokolliert.</p>';
}

// =========================================================================
// 9. ARTIKEL-ETIKETTEN & REGAL-QR WERKZEUG
// =========================================================================
function oeffneEtikettenTool() {
    const url = new URL(window.location.href);
    url.search = ''; url.searchParams.set('etiketten', '1');
    window.open(url.toString(), '_blank', 'noopener');
}
function oeffneQrGeneratorFenster() {
    const url = new URL(window.location.href);
    url.search = ''; url.searchParams.set('qrgen', '1');
    window.open(url.toString(), '_blank', 'noopener');
}

function renderArtikelEtikettenListe() {
    const ziel = $('etiketten-liste');
    if (!ziel) return;
    const filter = ($('etiketten-suche')?.value || '').toLowerCase().trim();
    const liste = alleArtikelInfos.filter(a => !filter || a.name.toLowerCase().includes(filter) || (a.kategorie || '').toLowerCase().includes(filter));

    ziel.innerHTML = liste.map(art => {
        const link = `https://trilager.pius-s.de?rueckgabe=${art.id}`;
        const chk = etikettenAuswahlIds.has(String(art.id));
        return `
            <div class="etikett-zeile ${chk ? 'ist-ausgewaehlt' : ''}">
                <label class="etikett-checkbox-wrap"><input type="checkbox" class="etikett-checkbox" data-id="${art.id}" ${chk ? 'checked' : ''} onchange="toggleEtikettAuswahl('${art.id}', this.checked)"></label>
                <div class="etikett-qr" id="etikett-qr-${art.id}"></div>
                <div class="etikett-info"><strong>${escapeHtml(art.name)}</strong><small>${escapeHtml(art.kategorie || 'Ohne Kategorie')} · ${formatArtikelId(art.id)}</small></div>
                <div class="etikett-aktionen">
                    <button class="btn" style="background:#1f5f8b;" onclick="downloadArtikelQr('${art.id}', '${escapeHtml(art.name)}')">⬇️ QR</button>
                    <button class="btn" style="background:#2980b9;" onclick="schreibeNfcTagFuerArtikel('${art.id}', '${escapeHtml(art.name)}')">📶 NFC schreiben</button>
                </div>
            </div>`;
    }).join('') || '<p style="text-align:center;">Keine Artikel gefunden.</p>';

    liste.forEach(art => {
        const c = $(`etikett-qr-${art.id}`);
        if (c) new QRCode(c, { text: `https://trilager.pius-s.de?rueckgabe=${art.id}`, width: 90, height: 90 });
    });
    aktualisiereEtikettenAuswahlUI();
}

function toggleEtikettAuswahl(id, chk) {
    if (chk) etikettenAuswahlIds.add(String(id)); else etikettenAuswahlIds.delete(String(id));
    aktualisiereEtikettenAuswahlUI();
}
function toggleAlleEtikettenAuswahl(chk) {
    document.querySelectorAll('.etikett-checkbox').forEach(cb => { cb.checked = chk; toggleEtikettAuswahl(cb.dataset.id, chk); });
}
function aktualisiereEtikettenAuswahlUI() {
    if ($('etiketten-auswahl-count')) $('etiketten-auswahl-count').textContent = etikettenAuswahlIds.size;
    if ($('etiketten-auswahl-drucken-btn')) $('etiketten-auswahl-drucken-btn').disabled = !etikettenAuswahlIds.size;
}

function downloadArtikelQr(aid, name) {
    const canvas = $(`etikett-qr-${aid}`)?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `qr_${name.replace(/[^a-z0-9-_]+/gi, '_')}.png`;
    a.click();
}
async function schreibeNfcTagFuerArtikel(aid, name) {
    await schreibeNfcUrlTag(`https://trilager.pius-s.de?rueckgabe=${aid}`, name);
}

function druckeAusgewaehlteEtiketten() {
    druckeEtiketten(alleArtikelInfos.filter(a => etikettenAuswahlIds.has(String(a.id))));
}
function druckeAlleEtiketten() { druckeEtiketten(alleArtikelInfos); }

function druckeEtiketten(liste) {
    const win = window.open('', '_blank');
    const items = liste.map(a => `
        <div class="etikett-print-item">
            <div class="etikett-print-qr" data-link="https://trilager.pius-s.de?rueckgabe=${a.id}"></div>
            <div class="etikett-print-text">
                <div class="etikett-print-name">${escapeHtml(a.name)}</div>
                <div class="etikett-print-id">${formatArtikelId(a.id)}</div>
            </div>
        </div>`).join('');

    win.document.write(`
        <html><head><title>Etiketten drucken</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
        <style>
            * { box-sizing:border-box; } body { font-family:sans-serif; padding:10mm; margin:0; }
            .etikett-print-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:6mm 5mm; }
            .etikett-print-item { width:42mm; display:flex; flex-direction:column; align-items:center; padding:3mm; border:1px dashed #bbb; border-radius:2mm; page-break-inside:avoid; }
            .etikett-print-qr { width:32mm; height:32mm; }
            .etikett-print-text { width:32mm; text-align:center; margin-top:2mm; font-size:11px; }
            .etikett-print-name { font-weight:bold; height:9mm; overflow:hidden; }
            @media print { .no-print { display:none; } }
        </style></head><body>
            <button class="no-print" onclick="window.print()" style="padding:10px 16px; margin-bottom:15px; cursor:pointer;">🖨️ Drucken</button>
            <div class="etikett-print-grid">${items}</div>
            <script>
                window.onload = function() {
                    document.querySelectorAll('.etikett-print-qr').forEach(el => new QRCode(el, { text: el.dataset.link, width: 240, height: 240 }));
                };
            <\/script>
        </body></html>`);
    win.document.close();
}

function aktualisiereRegalQrVorschau() {
    const inp = $('regal-qr-input'), prev = $('regal-qr-preview'), link = $('regal-qr-link');
    if (!inp || !prev || !link) return;
    const rName = extrahiereRegalName(inp.value.trim());
    if (!rName) { prev.style.display = 'none'; link.innerText = ''; return; }
    const url = `https://trilager.pius-s.de?regal=${encodeURIComponent(rName)}`;
    prev.innerHTML = '';
    new QRCode(prev, { text: url, width: 220, height: 220 });
    prev.style.display = 'flex'; link.href = url; link.innerText = url;
}
function downloadRegalQrDatei(fmt = 'png') {
    const c = $('regal-qr-preview')?.querySelector('canvas');
    if (!c) return showToast('Kein QR-Code vorhanden.', 'error');
    const a = document.createElement('a');
    a.href = c.toDataURL(fmt === 'jpg' ? 'image/jpeg' : 'image/png');
    a.download = `qr_${extrahiereRegalName($('regal-qr-input').value)}.${fmt}`;
    a.click();
}

// =========================================================================
// 10. FEEDBACK / FORMULAR MODUS
// =========================================================================
async function formularAntwortSpeichern() {
    const name = $('formular-name')?.value.trim() || 'Anonym';
    const frage1 = $('formular-frage1')?.value.trim() || '';
    const frage2 = $('formular-frage2')?.value.trim() || '';
    if (!frage1 && !frage2) return showToast('Bitte mindestens eine Frage beantworten.', 'warning');
    const { error } = await dbClient.from(TABLES.FORMULAR).insert([{ name, frage1, frage2 }]);
    if (error) showToast('Speichern fehlgeschlagen.', 'error');
    else { showToast('Danke für dein Feedback!'); $('formular-frage1').value = ''; $('formular-frage2').value = ''; }
}
async function formularAntwortenLaden() {
    const ziel = $('formular-antworten');
    const { data, error } = await dbClient.from(TABLES.FORMULAR).select('*').order('created_at', { ascending: false });
    if (error || !ziel) return;
    ziel.style.display = 'block';
    ziel.innerHTML = (data || []).map((e, idx) => `
        <div class="survey-answer-item">
            <h4>Antwort ${idx + 1} - ${new Date(e.created_at).toLocaleString('de-DE')}</h4>
            <p><strong>Name:</strong> ${escapeHtml(e.name)}</p>
            <p><strong>Frage 1:</strong> ${escapeHtml(e.frage1)}</p>
            <p><strong>Frage 2:</strong> ${escapeHtml(e.frage2)}</p>
        </div>`).join('') || '<p>Noch keine Antworten.</p>';
}

// =========================================================================
// 11. INITIALISIERUNG & NAVIGATION
// =========================================================================
function wechsleModus(modus) {
    aktuellerModus = modus;
    ['lager', 'event', 'kisten'].forEach(m => {
        const v = $(`ansicht-${m}`), t = $(`tab-${m}`);
        if (v) v.style.display = m === modus ? 'block' : 'none';
        if (t) t.className = m === modus ? 'btn btn-modus active' : 'btn btn-modus';
    });
    if (modus === 'event') ladeEventDaten();
    if (modus === 'kisten') renderKistenListe();
    else if (aktiverNfcModus === 'kisten') deaktiviereNfcModus('kisten');
}

function zurueckZurHauptseite() {
    deaktiviereAlleNfcModi();
    const url = new URL(window.location.href);
    url.search = '';
    window.location.href = url.toString();
}
function zurHauptseiteZurueck() { zurueckZurHauptseite(); }
function geheZuEntnahmeprotokoll() { window.location.href = 'https://trilager.pius-s.de?entnahme=1'; }

function pruefeUndVerarbeiteRueckgabeLink() {
    const p = new URLSearchParams(window.location.search), id = p.get('rueckgabe');
    if (!id) return;
    p.delete('rueckgabe');
    window.history.replaceState({}, '', window.location.pathname + (p.toString() ? '?' + p.toString() : ''));
    verarbeiteRueckgabeScan('artikel:' + id);
}
async function pruefeUndVerarbeiteKistencheckLink() {
    const p = new URLSearchParams(window.location.search), code = p.get('kistencheck');
    if (!code) return;
    p.delete('kistencheck');
    window.history.replaceState({}, '', window.location.pathname + (p.toString() ? '?' + p.toString() : ''));
    await ladeAlles();
    verarbeiteOrtScan(code);
}

function pruefeUndZeigeOnboarding() {
    if (!window.localStorage.getItem(STORAGE_KEYS.ONBOARDING)) oeffneOnboarding();
}
function oeffneOnboarding() { openModalById('onboardingModal'); }
function schliesseOnboarding() { closeModal('onboardingModal'); window.localStorage.setItem(STORAGE_KEYS.ONBOARDING, '1'); }
function openRechtliches(e, mid) { e.preventDefault(); openModalById(mid); }

// Tooltip- / Hover-Events
window.hoverWasLongPress = false;
let hoverTimer = null;
window.handleMouseEnter = (e) => {
    const t = e.currentTarget;
    if (t.dataset.hoverType === 'date') { $('hover-date-text').innerHTML = t.dataset.hoverContent; $('hover-date-info').style.display = 'block'; }
    if (t.dataset.hoverType === 'res') { $('hover-res-text').innerHTML = t.dataset.hoverContent; $('hover-res-info').style.display = 'block'; }
};
window.handleMouseLeave = () => { $('hover-date-info').style.display = 'none'; $('hover-res-info').style.display = 'none'; };
window.handleTouchStart = (e) => {
    window.hoverWasLongPress = false;
    hoverTimer = setTimeout(() => { window.hoverWasLongPress = true; window.handleMouseEnter(e); }, 400);
};
window.handleTouchMove = () => clearTimeout(hoverTimer);
window.handleTouchEnd = () => { clearTimeout(hoverTimer); setTimeout(window.handleMouseLeave, 2500); };

// DOMContentLoaded Handler
document.addEventListener('DOMContentLoaded', async () => {
    // Sanfte Modal-Animationen überwachen
    document.querySelectorAll('.modal').forEach(modal => {
        new MutationObserver(() => {
            const open = getComputedStyle(modal).display !== 'none';
            if (open) requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('modal-visible')));
            else modal.classList.remove('modal-visible');
        }).observe(modal, { attributes: true, attributeFilter: ['style'] });
    });

    if (QRGEN_MODUS) {
        $('qrgen-ansicht').style.display = 'block';
        $('login-overlay').style.display = 'none';
        document.querySelector('.container').style.display = 'none';
        aktualisiereRegalQrVorschau();
        return;
    }
    if (FORMULAR_MODUS) {
        $('formular-ansicht').style.display = 'block';
        $('login-overlay').style.display = 'none';
        document.querySelector('.container').style.display = 'none';
        return;
    }
    if (ENTNAHME_MODUS) return initEntnahmeModus();
    if (ETIKETTEN_MODUS) return initEtikettenModus();

    const session = holeLokaleSession();
    if (session) {
        setzeAuthToken(session.token);
        $('login-overlay').style.display = 'none';
        await ladeAlles();
        pruefeUndZeigeOnboarding();
        pruefeUndVerarbeiteRueckgabeLink();
        pruefeUndVerarbeiteKistencheckLink();
    } else {
        $('login-overlay').style.display = 'flex';
    }
});

async function initEntnahmeModus() {
    $('entnahme-ansicht').style.display = 'block';
    document.querySelector('.container').style.display = 'none';
    const s = holeLokaleSession();
    if (!s) { $('login-overlay').style.display = 'flex'; return; }
    setzeAuthToken(s.token);
    $('login-overlay').style.display = 'none';
    await ladeAlles();
    await ladeEntnahmeVorlagen();
    await ladeEntnahmeHistorie();
    const draft = entnahmeLadeDraftLokal();
    if (draft?.materialien) {
        entnahmeMaterialien = draft.materialien;
        entnahmeWizardZuSchritt(draft.step || 1);
        renderEntnahmeMaterialien();
    }
}

async function initEtikettenModus() {
    $('etiketten-ansicht').style.display = 'block';
    document.querySelector('.container').style.display = 'none';
    const s = holeLokaleSession();
    if (!s) { $('login-overlay').style.display = 'flex'; return; }
    setzeAuthToken(s.token);
    $('login-overlay').style.display = 'none';
    await ladeLagerorte();
    await ladeBestand();
    renderArtikelEtikettenListe();
}
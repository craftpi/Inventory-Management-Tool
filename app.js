//const SUPABASE_URL = 'https://frrfjpnrewwlgfqtgjqg.supabase.co';

const SUPABASE_URL = 'https://trilager-api.pius-s.de';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InRyaWxhZ2VyIiwiaWF0IjoxNzg1ODA3MzI1LCJleHAiOjIxMDExNjczMjV9.COsEZ-KOGycjE2S1eALGohmmjosW8CZs038jezg6lSU';

function storageAvailable(type) {
    try {
        var storage = window[type];
        var x = '__storage_test__';
        storage.setItem(x, x);
        storage.removeItem(x);
        return true;
    } catch (e) {
        return false;
    }
}

const _persistSession = storageAvailable('localStorage');
console.log('localStorage available for session persistence:', _persistSession);

let dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
});

function setzeAuthToken(token) {
    if (token) {
        dbClient.rest.headers.set('Authorization', `Bearer ${token}`);
    } else {
        dbClient.rest.headers.delete('Authorization');
    }
}

const FORMULAR_TABLE = 'formular_antworten';
const ENTNAHME_PROTOKOLL_TABLE = 'lager_entnahmen';
const ENTNAHME_BENUTZER_TABLE = 'lager_entnahme_benutzer_vorlagen';
const ENTNAHME_SAMMEL_TABLE = 'lager_entnahme_sammelvorlagen';
// append-only audit table for immutable entnahme records
const ENTNAHME_AUDIT_TABLE = 'lager_entnahme_audit';
const FORMULAR_MODUS = new URLSearchParams(window.location.search).get('formular') === '1';
const QRGEN_MODUS = new URLSearchParams(window.location.search).get('qrgen') === '1';
const ENTNAHME_MODUS = new URLSearchParams(window.location.search).get('entnahme') === '1';
const INITIAL_REGAL_FILTER = new URLSearchParams(window.location.search).get('regal') || '';
const LOCAL_SESSION_STORAGE_KEY = 'trilager_local_session_v2';
const LOGIN_ATTEMPTS_STORAGE_KEY = 'trilager_login_attempts_v1';
const LOGIN_LOCK_STORAGE_KEY = 'trilager_login_lock_until_v1';
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_DURATION_MS = 5 * 60 * 1000;
const LOCAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let aktuelleDaten = [];
let packlisten = [];
let packlistenPositionen = [];
let alleArtikelInfos = []; 
let alleLagerorte = []; 
let isEditMode = false;
let isEventEditMode = false;
let aktuellerModus = 'lager'; 
let einkaufslisteArray = []; 

let offeneGruppen = new Set();
let isAllOpen = false;
let sortAscending = true;
let autoFehlbestandListe = [];
let eigeneVorschlaegeListe = [];
let manuelleEintraegeListe = [];
let artikelIgnorieren = new Set();
let zeigeAlleArtikel = false;
let aktiverRegalFilter = extrahiereRegalName(INITIAL_REGAL_FILTER);
let entnahmeBenutzerVorlagen = [];
let entnahmeSammelvorlagen = [];
let entnahmeMaterialien = [];
let entnahmeHistorie = [];
let entnahmeVorlagenBearbeiten = false;
let entnahmeHistorieGeoeffnet = new Set();
let entnahmeAuswahlBenutzerId = '';
let entnahmeAuswahlSammelId = '';
let entnahmeBenutzerNeuAktiv = false;
let entnahmeSammelNeuAktiv = false;
let entnahmeVerbrauchProArtikel = {};
const ENTNAHME_DRAFT_STORAGE_KEY = 'inventory-management-tool.entnahmeDraft.v2';
let entnahmeWizardStep = 1;
let entnahmeActiveDraftId = '';
let entnahmeAutoSaveTimer = null;
let entnahmeAutoSaveInFlight = false;
let entnahmeAutoSaveQueued = false;
let entnahmeWizardAutoAdvanceAktiv = true;
let entnahmeSammelAutoSaveTimer = null;
let entnahmeSammelVorlageBestaetigtFuerId = '';

function holeLokaleSession() {
    try {
        const raw = window.localStorage.getItem(LOCAL_SESSION_STORAGE_KEY);
        if (!raw) return null;

        const session = JSON.parse(raw);
        if (!session || typeof session !== 'object') return null;

        const expiresAt = Number(session.expiresAt) || 0;
        if (!expiresAt || expiresAt <= Date.now()) {
            window.localStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
            return null;
        }

        return session;
    } catch (e) {
        return null;
    }
}

function speichereLokaleSession(user) {
    const session = {
        userId: String(user?.id || ''),
        userName: String(user?.username || user?.name || ''),
        token: String(user?.token || ''),
        issuedAt: Date.now(),
        expiresAt: Date.now() + LOCAL_SESSION_TTL_MS
    };

    window.localStorage.setItem(LOCAL_SESSION_STORAGE_KEY, JSON.stringify(session));
    setzeAuthToken(session.token);
}

function loescheLokaleSession() {
    window.localStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
}

function holeLoginSperreBis() {
    try {
        return Number(window.localStorage.getItem(LOGIN_LOCK_STORAGE_KEY) || '0') || 0;
    } catch (e) {
        return 0;
    }
}

function fuegeLoginFehlversuchHinzu() {
    const now = Date.now();
    const lockUntil = holeLoginSperreBis();
    if (lockUntil > now) return lockUntil;

    let attempts = 0;
    try {
        attempts = Number(window.localStorage.getItem(LOGIN_ATTEMPTS_STORAGE_KEY) || '0') || 0;
    } catch (e) {
        attempts = 0;
    }

    attempts += 1;
    window.localStorage.setItem(LOGIN_ATTEMPTS_STORAGE_KEY, String(attempts));

    if (attempts >= LOGIN_MAX_ATTEMPTS) {
        const gesperrtBis = now + LOGIN_LOCK_DURATION_MS;
        window.localStorage.setItem(LOGIN_LOCK_STORAGE_KEY, String(gesperrtBis));
        window.localStorage.removeItem(LOGIN_ATTEMPTS_STORAGE_KEY);
        return gesperrtBis;
    }

    return 0;
}

function setzeLoginFehlversucheZurueck() {
    window.localStorage.removeItem(LOGIN_ATTEMPTS_STORAGE_KEY);
    window.localStorage.removeItem(LOGIN_LOCK_STORAGE_KEY);
}

function entnahmeGetFormState() {
    const benutzerSelect = document.getElementById('entnahme-benutzer-vorlage');
    const sammelSelect = document.getElementById('entnahme-sammelvorlage');
    const nameFeld = document.getElementById('entnahme-name');
    const kontaktFeld = document.getElementById('entnahme-kontakt');

    return {
        step: entnahmeWizardStep,
        activeDraftId: entnahmeActiveDraftId,
        benutzerVorlageId: entnahmeAuswahlBenutzerId || benutzerSelect?.value || '',
        sammelVorlageId: entnahmeAuswahlSammelId || sammelSelect?.value || '',
        benutzerNeuAktiv: entnahmeBenutzerNeuAktiv,
        sammelNeuAktiv: entnahmeSammelNeuAktiv,
        name: nameFeld?.value.trim() || '',
        kontakt: kontaktFeld?.value.trim() || '',
        materialien: entnahmeMaterialien.map(item => ({ ...item }))
    };
}

function entnahmeSetzeFormState(state = {}) {
    entnahmeWizardStep = Math.min(3, Math.max(1, Number(state.step) || 1));
    entnahmeActiveDraftId = state.activeDraftId || '';
    entnahmeAuswahlBenutzerId = state.benutzerVorlageId || '';
    entnahmeAuswahlSammelId = state.sammelVorlageId || '';
    entnahmeBenutzerNeuAktiv = Boolean(state.benutzerNeuAktiv);
    entnahmeSammelNeuAktiv = Boolean(state.sammelNeuAktiv);

    const benutzerSelect = document.getElementById('entnahme-benutzer-vorlage');
    const sammelSelect = document.getElementById('entnahme-sammelvorlage');
    const nameFeld = document.getElementById('entnahme-name');
    const kontaktFeld = document.getElementById('entnahme-kontakt');

    if (benutzerSelect) benutzerSelect.value = entnahmeAuswahlBenutzerId || '';
    if (sammelSelect) sammelSelect.value = entnahmeAuswahlSammelId || '';
    if (nameFeld) nameFeld.value = typeof state.name === 'string' ? state.name : '';
    if (kontaktFeld) kontaktFeld.value = typeof state.kontakt === 'string' ? state.kontakt : '';

    entnahmeMaterialien = Array.isArray(state.materialien)
        ? state.materialien.map(item => ({
            artikel_id: item.artikel_id || null,
            label: item.label || item.name || '',
            kategorie: item.kategorie || '',
            einheit: item.einheit || 'Stück',
            menge: Number(item.menge) || 0
        }))
        : [];

    setzeEntnahmeVorlagenFormSichtbarkeit();
    entnahmeWizardAktualisieren();
    renderEntnahmeMaterialien();
}

function entnahmeLadeDraftLokal() {
    try {
        const raw = window.localStorage.getItem(ENTNAHME_DRAFT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.warn('Lokaler Entnahme-Entwurf konnte nicht geladen werden.', e);
        return null;
    }
}

function entnahmeSpeichereDraftLokal() {
    try {
        const state = entnahmeGetFormState();
        window.localStorage.setItem(ENTNAHME_DRAFT_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.warn('Lokaler Entnahme-Entwurf konnte nicht gespeichert werden.', e);
    }
}

function entnahmeLoescheDraftLokal() {
    try {
        window.localStorage.removeItem(ENTNAHME_DRAFT_STORAGE_KEY);
    } catch (e) {
        console.warn('Lokaler Entnahme-Entwurf konnte nicht gelöscht werden.', e);
    }
}

function entnahmeHatSpeicherbarenInhalt() {
    const state = entnahmeGetFormState();
    return Boolean(state.name) && Array.isArray(state.materialien) && state.materialien.length > 0;
}

function entnahmeAktualisiereStepIndicators() {
    const stepButtons = document.querySelectorAll('[data-entnahme-step-indicator]');
    stepButtons.forEach(button => {
        const step = Number(button.getAttribute('data-entnahme-step-indicator'));
        button.classList.toggle('active', step === entnahmeWizardStep);
        button.classList.toggle('complete', step < entnahmeWizardStep);
    });
}

function entnahmeWizardAktualisieren() {
    const stepPanels = document.querySelectorAll('[data-entnahme-step-panel]');
    stepPanels.forEach(panel => {
        const step = Number(panel.getAttribute('data-entnahme-step-panel'));
        panel.style.display = step === entnahmeWizardStep ? 'block' : 'none';
    });

    const navPrev = document.getElementById('entnahme-wizard-prev');
    const navNext = document.getElementById('entnahme-wizard-next');
    const navStatus = document.getElementById('entnahme-wizard-status');

    if (navPrev) navPrev.disabled = entnahmeWizardStep <= 1;
    if (navNext) {
        navNext.style.display = entnahmeWizardStep < 3 ? 'inline-flex' : 'none';
        navNext.textContent = entnahmeWizardStep === 1 ? 'Weiter zu Vorlage' : 'Weiter zu Materialien';
    }

    if (navStatus) {
        navStatus.textContent = entnahmeAutoSaveInFlight
            ? 'Speichert...'
            : entnahmeHatSpeicherbarenInhalt()
                ? 'Automatisch gespeichert'
                : 'Entwurf wird lokal zwischengespeichert';
    }

    const currentStepLabel = document.getElementById('entnahme-current-step-label');
    if (currentStepLabel) {
        currentStepLabel.textContent = entnahmeWizardStep === 1
            ? 'Schritt 1 von 3'
            : entnahmeWizardStep === 2
                ? 'Schritt 2 von 3'
                : 'Schritt 3 von 3';
    }

    entnahmeAktualisiereStepIndicators();
    entnahmeAktualisiereZusammenfassung();
}

function entnahmeAktualisiereZusammenfassung() {
    const benutzerInfo = document.getElementById('entnahme-summary-benutzer');
    const sammelInfo = document.getElementById('entnahme-summary-sammel');
    const materialInfo = document.getElementById('entnahme-summary-materialien');
    const stateInfo = document.getElementById('entnahme-summary-status');

    const benutzer = entnahmeBenutzerVorlagen.find(item => String(item.id) === String(entnahmeAuswahlBenutzerId));
    const sammel = entnahmeSammelvorlagen.find(item => String(item.id) === String(entnahmeAuswahlSammelId));
    const materialCount = entnahmeMaterialien.reduce((sum, item) => sum + (Number(item.menge) || 0), 0);

    if (benutzerInfo) benutzerInfo.textContent = benutzer?.name || document.getElementById('entnahme-name')?.value.trim() || 'Noch kein Benutzer';
    if (sammelInfo) sammelInfo.textContent = sammel?.name || document.getElementById('entnahme-sammelvorlagenname')?.value.trim() || 'Noch keine Sammel-Vorlage';
    if (materialInfo) materialInfo.textContent = entnahmeMaterialien.length > 0 ? `${entnahmeMaterialien.length} Position${entnahmeMaterialien.length === 1 ? '' : 'en'}, ${materialCount} Gesamtmenge` : 'Noch keine Materialien';
    if (stateInfo) stateInfo.textContent = entnahmeAutoSaveInFlight ? 'Speichert...' : 'Automatische Sicherung aktiv';
}

function entnahmeWizardZuSchritt(step) {
    entnahmeWizardStep = Math.min(3, Math.max(1, Number(step) || 1));
    entnahmeSpeichereDraftLokal();
    entnahmeWizardAktualisieren();
}

function entnahmeWizardZurueck() {
    entnahmeWizardZuSchritt(entnahmeWizardStep - 1);
}

function entnahmeWizardWeiter() {
    if (entnahmeWizardStep === 1) {
        const hatVorlageOderName = Boolean(
            document.getElementById('entnahme-benutzer-vorlage')?.value ||
            document.getElementById('entnahme-name')?.value.trim()
        );

        if (!hatVorlageOderName) {
            entnahmeAuswahlBenutzerId = '';
            entnahmeBenutzerNeuAktiv = true;
            const nameFeld = document.getElementById('entnahme-name');
            const kontaktFeld = document.getElementById('entnahme-kontakt');
            if (nameFeld) nameFeld.placeholder = 'Vor- und Nachname';
            if (kontaktFeld) kontaktFeld.placeholder = 'Telefon, E-Mail oder Hinweis';
        }
    }

    if (entnahmeWizardStep === 2) {
        const hatVorlageOderName = Boolean(
            document.getElementById('entnahme-sammelvorlage')?.value ||
            document.getElementById('entnahme-sammelvorlagenname')?.value.trim() ||
            entnahmeMaterialien.length > 0
        );

        if (!hatVorlageOderName) {
            entnahmeAuswahlSammelId = '';
            entnahmeSammelNeuAktiv = true;
        }
    }

    entnahmeWizardZuSchritt(Math.min(3, entnahmeWizardStep + 1));
}

function entnahmeWizardAutoAdvanceSetzen(aktiv) {
    entnahmeWizardAutoAdvanceAktiv = Boolean(aktiv);
}

function entnahmeWizardAutoAdvanceErlaubt() {
    return entnahmeWizardAutoAdvanceAktiv && !entnahmeVorlagenBearbeiten;
}

function entnahmeMarkiereAutoSaveAlsErforderlich() {
    entnahmeSpeichereDraftLokal();
    entnahmeWizardAktualisieren();
    entnahmeSammelvorlageAutoSpeichernAnstossen();
}

function entnahmeSammelvorlageAutoSpeichernAnstossen() {
    if (entnahmeSammelAutoSaveTimer) clearTimeout(entnahmeSammelAutoSaveTimer);
    entnahmeSammelAutoSaveTimer = setTimeout(() => {
        entnahmeSammelAutoSaveTimer = null;
        entnahmeSammelvorlageAutoSpeichern();
    }, 550);
}

async function entnahmeSammelvorlageAutoSpeichern() {
    const name = document.getElementById('entnahme-sammelvorlagenname')?.value.trim() || '';
    const selectValue = document.getElementById('entnahme-sammelvorlage')?.value || document.getElementById('entnahme-sammelvorlage-bearbeiten')?.value || '';
    const bestehendeId = entnahmeAuswahlSammelId || (selectValue && selectValue !== '__new__' ? selectValue : '');

    if (!name || entnahmeMaterialien.length === 0) {
        return null;
    }

    if (String(bestehendeId).startsWith('pack:')) {
        return null;
    }

    if (bestehendeId && entnahmeVorlagenBearbeiten && entnahmeSammelVorlageBestaetigtFuerId !== String(bestehendeId)) {
        const ok = confirm('Soll die ausgewählte Sammel-Vorlage mit den aktuellen Materialien überschrieben werden?');
        if (!ok) return null;
        entnahmeSammelVorlageBestaetigtFuerId = String(bestehendeId);
    }

    const payload = { name, materialien: entnahmeMaterialien.map(item => ({ ...item })) };
    const result = bestehendeId
        ? await dbClient.from(ENTNAHME_SAMMEL_TABLE).update(payload).eq('id', bestehendeId).select()
        : await dbClient.from(ENTNAHME_SAMMEL_TABLE).insert([payload]).select();

    if (result.error) {
        console.error('Sammelforlage konnte nicht automatisch gespeichert werden.', result.error);
        return null;
    }

    if (result.data && result.data[0]?.id) {
        entnahmeAuswahlSammelId = String(result.data[0].id);
        const selectElement = document.getElementById('entnahme-sammelvorlage');
        if (selectElement) selectElement.value = entnahmeAuswahlSammelId;
        entnahmeSammelVorlageBestaetigtFuerId = entnahmeAuswahlSammelId;
    }

    await ladeEntnahmeVorlagen();
    return entnahmeAuswahlSammelId || bestehendeId || null;
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if(!container) return;
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

let hoverPressTimer = null;
let hoverWasLongPress = false;
let hoverHideTimer = null;

window.handleMouseEnter = function(e) {
    if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return; 
    clearTimeout(hoverHideTimer);
    let el = e.currentTarget;
    let type = el.getAttribute('data-hover-type');
    let content = el.getAttribute('data-hover-content');
    if (type === 'date') showDateHover(content);
    if (type === 'res') showResHover(content);
};

window.handleMouseLeave = function(e) {
    hideDateHover();
    hideResHover();
};

window.handleTouchStart = function(e) {
    let el = e.currentTarget;
    let type = el.getAttribute('data-hover-type');
    let content = el.getAttribute('data-hover-content');
    
    clearTimeout(hoverHideTimer);
    hoverWasLongPress = false;
    
    hoverPressTimer = setTimeout(() => {
        hoverWasLongPress = true;
        if (type === 'date') showDateHover(content);
        if (type === 'res') showResHover(content);
        if (navigator.vibrate) navigator.vibrate(50);
    }, 400);
};

window.handleTouchMove = function(e) {
    clearTimeout(hoverPressTimer);
};

window.handleTouchEnd = function(e) {
    clearTimeout(hoverPressTimer);
    if (hoverWasLongPress) {
        hoverHideTimer = setTimeout(() => {
            hideDateHover();
            hideResHover();
        }, 3000);
    } else {
        hideDateHover();
        hideResHover();
    }
    setTimeout(() => { hoverWasLongPress = false; }, 50);
};

function showDateHover(dateString) {
    const box = document.getElementById('hover-date-info');
    const text = document.getElementById('hover-date-text');
    if (box && text) {
        text.innerHTML = dateString;
        box.style.display = 'block';
    }
}
function hideDateHover() {
    const box = document.getElementById('hover-date-info');
    if (box) box.style.display = 'none';
}
function showResHover(content) {
    const box = document.getElementById('hover-res-info');
    const text = document.getElementById('hover-res-text');
    if (box && text) { 
        text.innerHTML = content; 
        box.style.display = 'block'; 
    }
}
function hideResHover() {
    const box = document.getElementById('hover-res-info');
    if (box) box.style.display = 'none';
}

// Sicherer Mini-Parser für einfache Mengen-Rechnungen wie "3+2" oder "(4-1)*2".
// Bewertet NUR Zahlen und + - * / ( ), ohne new Function()/eval() – es kann also
// niemals beliebiger JavaScript-Code ausgeführt werden, egal was eingegeben wird.
function berechneMengenAusdruck(ausdruck) {
    let pos = 0;

    function fehler() { throw new Error('Ungültiger Ausdruck'); }

    function parseZahl() {
        let start = pos;
        while (pos < ausdruck.length && /[0-9.]/.test(ausdruck[pos])) pos++;
        if (pos === start) fehler();
        const wert = parseFloat(ausdruck.slice(start, pos));
        if (Number.isNaN(wert)) fehler();
        return wert;
    }

    function parseKlammerOderZahl() {
        if (ausdruck[pos] === '(') {
            pos++;
            const wert = parseAusdruck();
            if (ausdruck[pos] !== ')') fehler();
            pos++;
            return wert;
        }
        if (ausdruck[pos] === '-') {
            pos++;
            return -parseKlammerOderZahl();
        }
        if (ausdruck[pos] === '+') {
            pos++;
            return parseKlammerOderZahl();
        }
        return parseZahl();
    }

    function parseTerm() {
        let wert = parseKlammerOderZahl();
        while (ausdruck[pos] === '*' || ausdruck[pos] === '/') {
            const op = ausdruck[pos];
            pos++;
            const rechts = parseKlammerOderZahl();
            wert = op === '*' ? wert * rechts : wert / rechts;
        }
        return wert;
    }

    function parseAusdruck() {
        let wert = parseTerm();
        while (ausdruck[pos] === '+' || ausdruck[pos] === '-') {
            const op = ausdruck[pos];
            pos++;
            const rechts = parseTerm();
            wert = op === '+' ? wert + rechts : wert - rechts;
        }
        return wert;
    }

    const ergebnis = parseAusdruck();
    if (pos !== ausdruck.length) fehler();
    return ergebnis;
}

function werteMengeAus(eingabe) {
    if (eingabe === undefined || eingabe === null) return 0;
    const saubererString = String(eingabe).replace(/[^0-9+\-*/().]/g, '');
    if (saubererString === '') return 0;
    try {
        const ergebnis = berechneMengenAusdruck(saubererString);
        if (!Number.isFinite(ergebnis)) return 0;
        return Math.round(ergebnis);
    } catch (e) { return 0; }
}

const BESTAND_STRICH_AUSREICHEND = -2;
const BESTAND_STRICH_NACHKAUF = -3;

function aktualisiereMengeEingabeFarbe(feld) {
    if (!feld) return;

    const wert = String(feld.value ?? '').trim();
    feld.classList.remove('bestand-menge-ok', 'bestand-menge-low');

    if (!wert || wert === '-' || wert === '∞') {
        return;
    }

    const menge = werteMengeAus(wert);
    if (!Number.isFinite(menge)) return;

    feld.classList.add(menge > 0 ? 'bestand-menge-ok' : 'bestand-menge-low');
}

function bestandEingabeGeaendert(feld) {
    const row = feld?.closest('.lagerort-row, .edit-ort-row');
    if (!row || !feld) return;

    const wert = String(feld.value ?? '').trim();
    const infBtn = row.querySelector('.bestand-btn-inf');
    const minusBtn = row.querySelector('.bestand-btn-minus');
    const nachkaufWrap = row.querySelector('.bestand-nachkauf-wrap');
    const nachkaufCheckbox = row.querySelector('.bestand-nachkauf-checkbox');

    if (wert === '∞') {
        row.dataset.stockMode = 'inf';
        row.dataset.nachkauf = 'false';
        if (nachkaufCheckbox) nachkaufCheckbox.checked = false;
        if (nachkaufWrap) nachkaufWrap.style.display = 'none';
    } else if (wert === '-') {
        row.dataset.stockMode = nachkaufCheckbox?.checked ? 'strich-warn' : 'strich-ok';
        if (nachkaufWrap) nachkaufWrap.style.display = 'flex';
    } else {
        row.dataset.stockMode = 'zahl';
        row.dataset.nachkauf = 'false';
        if (nachkaufCheckbox) nachkaufCheckbox.checked = false;
        if (nachkaufWrap) nachkaufWrap.style.display = 'none';
    }

    if (infBtn) {
        infBtn.classList.toggle('active-inf', row.dataset.stockMode === 'inf');
        infBtn.style.background = row.dataset.stockMode === 'inf' ? '#27ae60' : '#95a5a6';
    }

    if (minusBtn) {
        const minusAktiv = row.dataset.stockMode === 'strich-ok';
        const minusWarn = row.dataset.stockMode === 'strich-warn';
        minusBtn.classList.toggle('active-minus-ok', minusAktiv);
        minusBtn.classList.toggle('active-minus-warn', minusWarn);
        minusBtn.style.background = minusWarn ? '#c0392b' : (minusAktiv ? '#27ae60' : '#95a5a6');
    }

    aktualisiereMengeEingabeFarbe(feld);
}

function leseBestandswertAusZeile(row) {
    const input = row?.querySelector('input');
    const status = row?.dataset?.stockMode || 'zahl';
    const rawValue = String(input?.value ?? '').trim();

    if (status === 'inf' || rawValue === '∞') return -1;
    if (status === 'strich-warn') return BESTAND_STRICH_NACHKAUF;
    if (status === 'strich-ok' || rawValue === '-') {
        return BESTAND_STRICH_AUSREICHEND;
    }

    return werteMengeAus(rawValue);
}

function setzeBestandStatus(row, status = 'zahl', nachkauf = false) {
    if (!row) return;

    const input = row.querySelector('.new-menge, .edit-menge-input');
    const infBtn = row.querySelector('.bestand-btn-inf');
    const minusBtn = row.querySelector('.bestand-btn-minus');
    const nachkaufWrap = row.querySelector('.bestand-nachkauf-wrap');
    const nachkaufCheckbox = row.querySelector('.bestand-nachkauf-checkbox');
    const normStatus = ['zahl', 'inf', 'strich-ok', 'strich-warn'].includes(status) ? status : 'zahl';
    const isStrich = normStatus === 'strich-ok' || normStatus === 'strich-warn';

    row.dataset.stockMode = isStrich ? (normStatus === 'strich-warn' ? 'strich-warn' : 'strich-ok') : normStatus;
    row.dataset.nachkauf = isStrich && nachkauf ? 'true' : 'false';

    if (nachkaufCheckbox) nachkaufCheckbox.checked = Boolean(isStrich && nachkauf);
    if (nachkaufWrap) nachkaufWrap.style.display = isStrich ? 'flex' : 'none';

    if (input) {
        if (normStatus === 'zahl') {
            input.value = input.getAttribute('data-old-value') || (input.value === '∞' || input.value === '-' ? '0' : input.value || '0');
        } else if (normStatus === 'inf') {
            if (input.value !== '∞') input.setAttribute('data-old-value', input.value || '0');
            input.value = '∞';
        } else {
            if (input.value !== '-') input.setAttribute('data-old-value', input.value || '0');
            input.value = '-';
        }
        input.disabled = false;
        aktualisiereMengeEingabeFarbe(input);
    }

    if (infBtn) {
        infBtn.classList.toggle('active-inf', normStatus === 'inf');
        infBtn.style.background = normStatus === 'inf' ? '#27ae60' : '#95a5a6';
    }

    if (minusBtn) {
        minusBtn.classList.toggle('active-minus-ok', normStatus === 'strich-ok' && !nachkauf);
        minusBtn.classList.toggle('active-minus-warn', normStatus === 'strich-warn' || (normStatus === 'strich-ok' && nachkauf));
        minusBtn.style.background = (normStatus === 'strich-warn' || (normStatus === 'strich-ok' && nachkauf)) ? '#c0392b' : (normStatus === 'strich-ok' ? '#27ae60' : '#95a5a6');
    }
}

function toggleBestandInf(btn) {
    const row = btn?.closest('.lagerort-row, .edit-ort-row');
    if (!row) return;

    const current = row.dataset.stockMode || 'zahl';
    setzeBestandStatus(row, current === 'inf' ? 'zahl' : 'inf', false);
}

function toggleBestandMinus(btn) {
    const row = btn?.closest('.lagerort-row, .edit-ort-row');
    if (!row) return;

    const current = row.dataset.stockMode || 'zahl';
    const nextStatus = current.startsWith('strich') ? 'zahl' : 'strich-ok';
    setzeBestandStatus(row, nextStatus, row.dataset.nachkauf === 'true');
}

function toggleNachkaufCheckbox(checkbox) {
    const row = checkbox?.closest('.lagerort-row, .edit-ort-row');
    if (!row) return;

    const current = row.dataset.stockMode || 'zahl';
    if (!current.startsWith('strich')) {
        checkbox.checked = false;
        return;
    }

    setzeBestandStatus(row, checkbox.checked ? 'strich-warn' : 'strich-ok', checkbox.checked);
}

function gibFormularLink() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('formular', '1');
    return url.toString();
}

function gibEntnahmeLink() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('entnahme', '1');
    return url.toString();
}

function gibEntnahmeArtikelLabel(artikel) {
    if (!artikel) return '';
    return (artikel.kategorie ? artikel.kategorie + ' > ' : '') + artikel.name;
}

function normalisiereRegalText(text) {
    return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function extrahiereRegalName(text) {
    const roherText = String(text || '').trim();
    if (!roherText) return '';

    const match = roherText.match(/\(([^)]+)\)\s*$/);
    if (match && match[1]) {
        return match[1].trim();
    }

    return roherText;
}

function vergleicheRegalNamen(a, b, sortFactor = 1) {
    const aName = extrahiereRegalName(a) || String(a || '').trim();
    const bName = extrahiereRegalName(b) || String(b || '').trim();
    return aName.localeCompare(bName, 'de', { numeric: true, sensitivity: 'base' }) * sortFactor;
}

function ermittleRegalSchluessel(bestaende) {
    const regale = (bestaende || [])
        .map(b => extrahiereRegalName(b.lagerorte?.name || ''))
        .filter(Boolean)
        .sort((a, b) => vergleicheRegalNamen(a, b));

    return regale[0] || '';
}

function textEnthaeltRegal(text, regalName) {
    const normRegal = normalisiereRegalText(regalName);
    const roherText = String(text || '');
    const normText = normalisiereRegalText(roherText);

    if (!normRegal || !normText) return false;
    if (normText.includes(`(${normRegal})`)) return true;

    const parenTreffer = [...roherText.matchAll(/\(([^)]+)\)/g)].some(match => normalisiereRegalText(match[1]) === normRegal);
    if (parenTreffer) return true;

    const wortTreffer = new RegExp(`(^|[^a-z0-9])${normRegal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(normText);
    if (wortTreffer) return true;

    return normRegal.length > 3 && normText.includes(normRegal);
}

function gibRegalLink(regalText) {
    const regalName = extrahiereRegalName(regalText);
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    if (regalName) {
        url.searchParams.set('regal', regalName);
    }
    return url.toString();
}

function setzeRegalFilter(regalText, syncUrl = true) {
    aktiverRegalFilter = extrahiereRegalName(regalText);

    if (syncUrl) {
        const url = new URL(window.location.href);
        if (aktiverRegalFilter) {
            url.searchParams.set('regal', aktiverRegalFilter);
        } else {
            url.searchParams.delete('regal');
        }
        window.history.replaceState({}, '', url.toString());
    }

    const comboDropdown = document.getElementById('ort-filter-combo');
    if (comboDropdown) {
        comboDropdown.value = aktiverRegalFilter ? 'regal:' + aktiverRegalFilter : '';
    }

    const input = document.getElementById('regal-qr-input');
    if (input && input.value !== regalText) {
        input.value = regalText || '';
    }

    aktualisiereRegalQrVorschau();
    wendeFilterAn();
}

function ortComboChanged() {
    const val = document.getElementById('ort-filter-combo')?.value || '';
    if (val.startsWith('regal:')) {
        setzeRegalFilter(val.substring(6), true);
    } else if (val.startsWith('ort:')) {
        aktiverRegalFilter = '';
        const url = new URL(window.location.href);
        url.searchParams.delete('regal');
        window.history.replaceState({}, '', url.toString());
        wendeFilterAn();
    } else {
        aktiverRegalFilter = '';
        const url = new URL(window.location.href);
        url.searchParams.delete('regal');
        window.history.replaceState({}, '', url.toString());
        wendeFilterAn();
    }
}

function aktualisiereRegalQrVorschau() {
    const input = document.getElementById('regal-qr-input');
    const preview = document.getElementById('regal-qr-preview');
    const linkEl = document.getElementById('regal-qr-link');
    const hinweis = document.getElementById('regal-qr-hinweis');

    if (!input || !preview || !linkEl) return;

    const eingabe = input.value.trim();
    if (!eingabe) {
        preview.innerHTML = '';
        preview.style.display = 'none';
        linkEl.innerText = '';
        linkEl.href = '#';
        if (hinweis) hinweis.innerText = 'QR-Text eingeben, zum Beispiel: Fach Briefumschläge (Regal A)';
        return;
    }

    const regalName = extrahiereRegalName(eingabe);
    const qrLink = gibRegalLink(regalName);

    preview.innerHTML = '';
    new QRCode(preview, {
        text: qrLink,
        width: 220,
        height: 220,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    preview.dataset.qrLink = qrLink;
    preview.style.display = 'flex';
    linkEl.href = qrLink;
    linkEl.innerText = qrLink;

    if (hinweis) {
        hinweis.innerText = `QR-Ziel: ${regalName}`;
    }
}

function initRegalQrTool() {
    const input = document.getElementById('regal-qr-input');
    if (!input) return;

    if (aktiverRegalFilter) {
        input.value = aktiverRegalFilter;
    }

    aktualisiereRegalQrVorschau();
}

function downloadRegalQrDatei(format = 'png') {
    const input = document.getElementById('regal-qr-input');
    const preview = document.getElementById('regal-qr-preview');
    if (!input || !preview) return;

    const eingabe = input.value.trim();
    if (!eingabe) {
        showToast('Bitte zuerst einen Regalnamen eingeben.', 'warning');
        return;
    }

    const canvas = preview.querySelector('canvas');
    if (!canvas) {
        showToast('QR-Code konnte nicht erzeugt werden.', 'error');
        return;
    }

    const safeName = extrahiereRegalName(eingabe).replace(/[^a-z0-9-_]+/gi, '_') || 'qr-code';
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(canvas, 0, 0);

    const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const dataUrl = format === 'jpg'
        ? exportCanvas.toDataURL(mimeType, 0.95)
        : exportCanvas.toDataURL(mimeType);

    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = `${safeName}.${format === 'jpg' ? 'jpg' : 'png'}`;
    anchor.click();
}

function initQrGenModus() {
    const qrView = document.getElementById('qrgen-ansicht');
    if (qrView) qrView.style.display = 'block';

    const loginOverlay = document.getElementById('login-overlay');
    if (loginOverlay) loginOverlay.style.display = 'none';

    const appContainer = document.querySelector('.container');
    if (appContainer) {
        appContainer.style.background = 'transparent';
        appContainer.style.boxShadow = 'none';
        appContainer.style.maxWidth = '1000px';
        appContainer.style.padding = '0';
        Array.from(appContainer.children).forEach(child => {
            if (child.id !== 'qrgen-ansicht') child.style.display = 'none';
        });
    }

    const appFooter = document.querySelector('.app-footer');
    if (appFooter) appFooter.style.display = '';

    const hoverDate = document.getElementById('hover-date-info');
    const hoverRes = document.getElementById('hover-res-info');
    if (hoverDate) hoverDate.style.display = 'none';
    if (hoverRes) hoverRes.style.display = 'none';

    document.title = 'QR-Code Generator';
    initRegalQrTool();
}

function oeffneQrGeneratorFenster() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('qrgen', '1');
    window.open(url.toString(), '_blank', 'noopener');
}

function initFormularLink() {
    const linkEl = document.getElementById('formular-share-link');
    if (!linkEl) return;
    const formularLink = gibFormularLink();
    linkEl.href = formularLink;
    linkEl.innerText = formularLink;
}

function initEntnahmeLink() {
    const linkEl = document.getElementById('entnahme-share-link');
    if (!linkEl) return;
    const entnahmeLink = gibEntnahmeLink();
    linkEl.href = entnahmeLink;
    linkEl.innerText = entnahmeLink;
}

function initFormularModus() {
    const formularView = document.getElementById('formular-ansicht');
    if (formularView) formularView.style.display = 'block';

    const loginOverlay = document.getElementById('login-overlay');
    if (loginOverlay) loginOverlay.style.display = 'none';

    const appContainer = document.querySelector('.container');
    if (appContainer) appContainer.style.display = 'none';

    const appFooter = document.querySelector('.app-footer');
    if (appFooter) appFooter.style.display = '';

    const hoverDate = document.getElementById('hover-date-info');
    const hoverRes = document.getElementById('hover-res-info');
    if (hoverDate) hoverDate.style.display = 'none';
    if (hoverRes) hoverRes.style.display = 'none';
}

function setzeEntnahmeSicht(istGesperrt) {
    const lock = document.getElementById('entnahme-lock');
    const content = document.getElementById('entnahme-content');

    if (lock) lock.style.display = istGesperrt ? 'block' : 'none';
    if (content) content.style.display = istGesperrt ? 'none' : 'block';
}

function setzeHauptansichtZurueck() {
    const appContainer = document.querySelector('.container');
    if (appContainer) {
        appContainer.style.background = '';
        appContainer.style.boxShadow = '';
        appContainer.style.maxWidth = '';
        appContainer.style.padding = '';
        Array.from(appContainer.children).forEach(child => {
            child.style.display = '';
        });
    }

    const specialViews = [
        'entnahme-ansicht',
        'qrgen-ansicht',
        'formular-ansicht'
    ];

    specialViews.forEach(viewId => {
        const view = document.getElementById(viewId);
        if (view) view.style.display = 'none';
    });

    const appFooter = document.querySelector('.app-footer');
    if (appFooter) appFooter.style.display = '';

    const hoverDate = document.getElementById('hover-date-info');
    const hoverRes = document.getElementById('hover-res-info');
    if (hoverDate) hoverDate.style.display = '';
    if (hoverRes) hoverRes.style.display = '';
}

function aktualisiereEntnahmeMaterialDatalist() {
    const datalist = document.getElementById('entnahme-artikel-datalist');
    if (!datalist) return;

    datalist.innerHTML = '';
    [...alleArtikelInfos]
        .sort((a, b) => {
            const aLabel = gibEntnahmeArtikelLabel(a);
            const bLabel = gibEntnahmeArtikelLabel(b);
            return aLabel.localeCompare(bLabel, 'de', { numeric: true, sensitivity: 'base' });
        })
        .forEach(art => {
            const option = document.createElement('option');
            option.value = gibEntnahmeArtikelLabel(art);
            datalist.appendChild(option);
        });
}

function renderEntnahmeMaterialien() {
    const tbody = document.getElementById('entnahme-material-liste');
    if (!tbody) return;

    if (entnahmeMaterialien.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#666; padding:18px;">Noch keine Materialien ausgewählt.</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    entnahmeMaterialien.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(item.label)}</strong><br><small style="color:#666;">${escapeHtml(item.einheit || 'Stück')}</small></td>
            <td style="width:120px;"><input type="text" value="${escapeHtml(item.menge)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:6px; text-align:center;" onchange="entnahmeMaterialMengeAendern(${index}, this.value)"></td>
            <td style="width:70px; text-align:right;"><button class="btn" style="background:#e74c3c; width:auto; padding:8px 10px;" onclick="entnahmeMaterialLoeschen(${index})">🗑️</button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function ladeAktuelleEntnahmeVerbraeuche() {
    const result = await dbClient
        .from(ENTNAHME_PROTOKOLL_TABLE)
        .select('materialien');

    if (result.error) {
        console.warn('Aktuelle Entnahme-Verbräuche konnten nicht geladen werden.', result.error);
        entnahmeVerbrauchProArtikel = {};
        return;
    }

    const verbrauchMap = {};
    (result.data || []).forEach(entnahme => {
        const materialien = Array.isArray(entnahme.materialien) ? entnahme.materialien : [];
        materialien.forEach(material => {
            const artikelId = material?.artikel_id;
            const menge = Number(material?.menge) || 0;
            if (!artikelId || menge <= 0) return;
            verbrauchMap[String(artikelId)] = (verbrauchMap[String(artikelId)] || 0) + menge;
        });
    });

    entnahmeVerbrauchProArtikel = verbrauchMap;
}

function berechneArtikelVerfuegbarkeit(artId, bestaende = []) {
    let gesamtBestand = 0;
    let hatUnendlich = false;
    let hatStrich = false;

    bestaende.forEach(b => {
        const menge = Number(b.menge);
        if (menge === -1) hatUnendlich = true;
        else if (menge === -2) hatStrich = true;
        else if (menge >= 0) gesamtBestand += menge;
    });

    if (hatUnendlich) return '∞';
    if (hatStrich && gesamtBestand === 0) return '-';

    const entnommen = Number(entnahmeVerbrauchProArtikel[String(artId)] || 0);
    return Math.max(0, gesamtBestand - entnommen);
}

function setzeEntnahmeVorlagenFormSichtbarkeit() {
    const bodies = document.querySelectorAll('.entnahme-vorlagen-form');
    const sammelAuswahl = document.getElementById('entnahme-sammelvorlage')?.value || '';
    bodies.forEach(body => {
        const istBenutzerForm = Boolean(body.querySelector('#entnahme-name'));
        const istSammelForm = Boolean(body.querySelector('#entnahme-sammelvorlagenname'));
        const show = istBenutzerForm
            ? (entnahmeVorlagenBearbeiten || entnahmeBenutzerNeuAktiv || !entnahmeAuswahlBenutzerId)
            : istSammelForm
                ? (entnahmeVorlagenBearbeiten || entnahmeSammelNeuAktiv)
                : Boolean(entnahmeVorlagenBearbeiten);

        body.style.display = show ? 'block' : 'none';

        const panel = body.closest('details.entnahme-accordion');
        if (panel) panel.open = show;
    });

}

function entnahmeBenutzerVorlageInFormenLaden(vorlagenId = '') {
    const vorlage = entnahmeBenutzerVorlagen.find(item => String(item.id) === String(vorlagenId));
    const mainSelect = document.getElementById('entnahme-benutzer-vorlage');
    const editSelect = document.getElementById('entnahme-benutzer-vorlage-bearbeiten');
    const nameFeld = document.getElementById('entnahme-name');
    const kontaktFeld = document.getElementById('entnahme-kontakt');

    entnahmeAuswahlBenutzerId = vorlage ? String(vorlage.id) : '';
    entnahmeBenutzerNeuAktiv = !vorlage;

    if (mainSelect && mainSelect.value !== entnahmeAuswahlBenutzerId) mainSelect.value = entnahmeAuswahlBenutzerId;
    if (editSelect && editSelect.value !== entnahmeAuswahlBenutzerId) editSelect.value = entnahmeAuswahlBenutzerId;
    if (nameFeld) nameFeld.value = vorlage?.name || '';
    if (kontaktFeld) kontaktFeld.value = vorlage?.kontakt || '';

    setzeEntnahmeVorlagenFormSichtbarkeit();
    aktualisiereEntnahmeVorlagenInfo();
    entnahmeMarkiereAutoSaveAlsErforderlich();
    entnahmeWizardAktualisieren();
}

function entnahmeSammelvorlageInFormenLaden(vorlagenId = '') {
    const vorlage = entnahmeSammelvorlagen.find(item => String(item.id) === String(vorlagenId));
    const mainSelect = document.getElementById('entnahme-sammelvorlage');
    const editSelect = document.getElementById('entnahme-sammelvorlage-bearbeiten');
    const nameFeld = document.getElementById('entnahme-sammelvorlagenname');

    entnahmeAuswahlSammelId = vorlage ? String(vorlage.id) : '';
    entnahmeSammelNeuAktiv = !vorlage;

    if (mainSelect && mainSelect.value !== entnahmeAuswahlSammelId) mainSelect.value = entnahmeAuswahlSammelId;
    if (editSelect && editSelect.value !== entnahmeAuswahlSammelId) editSelect.value = entnahmeAuswahlSammelId;
    if (nameFeld) nameFeld.value = vorlage?.name || '';

    if (vorlage) {
        const materialien = Array.isArray(vorlage.materialien)
            ? vorlage.materialien
            : (typeof vorlage.materialien === 'string' ? JSON.parse(vorlage.materialien || '[]') : []);

        entnahmeMaterialien = materialien.map(item => ({
            artikel_id: item.artikel_id || null,
            label: item.label || item.name || '',
            kategorie: item.kategorie || '',
            einheit: item.einheit || 'Stück',
            menge: Number(item.menge) || 0
        }));
    } else {
        entnahmeMaterialien = [];
    }

    setzeEntnahmeVorlagenFormSichtbarkeit();
    aktualisiereEntnahmeVorlagenInfo();
    renderEntnahmeMaterialien();
    entnahmeMarkiereAutoSaveAlsErforderlich();
    entnahmeWizardAktualisieren();
}

function entnahmeBenutzerVorlageZumBearbeitenAuswaehlen() {
    entnahmeBenutzerVorlageInFormenLaden(document.getElementById('entnahme-benutzer-vorlage-bearbeiten')?.value || '');
}

function entnahmeSammelvorlageZumBearbeitenAuswaehlen() {
    entnahmeSammelvorlageInFormenLaden(document.getElementById('entnahme-sammelvorlage-bearbeiten')?.value || '');
}

function entnahmeVorlageFormenAktualisieren() {
    fillEntnahmeVorlagenDropdowns();
    entnahmeBenutzerVorlageInFormenLaden(entnahmeAuswahlBenutzerId);
    entnahmeSammelvorlageInFormenLaden(entnahmeAuswahlSammelId);
}

function oeffneVorlagenOverlay() {
    entnahmeVorlagenBearbeiten = true;
    fillEntnahmeVorlagenDropdowns();
    if (entnahmeAuswahlBenutzerId) {
        entnahmeBenutzerVorlageInFormenLaden(entnahmeAuswahlBenutzerId);
    }
    if (entnahmeAuswahlSammelId && entnahmeSammelvorlagen.some(item => String(item.id) === String(entnahmeAuswahlSammelId))) {
        entnahmeSammelvorlageInFormenLaden(entnahmeAuswahlSammelId);
    }
    entnahmeWizardAutoAdvanceSetzen(false);
    setzeEntnahmeVorlagenFormSichtbarkeit();

    const modal = document.getElementById('vorlagenModal');
    if (modal) modal.style.display = 'block';
}

function schliesseVorlagenOverlay() {
    const modal = document.getElementById('vorlagenModal');
    if (modal) modal.style.display = 'none';

    entnahmeVorlagenBearbeiten = false;
    entnahmeBenutzerNeuAktiv = false;
    entnahmeSammelNeuAktiv = false;
    entnahmeWizardAutoAdvanceSetzen(true);
    setzeEntnahmeVorlagenFormSichtbarkeit();
}

function aktualisiereEntnahmeVorlagenInfo() {
    const benutzerInfo = document.getElementById('entnahme-benutzer-info');
    const sammelInfo = document.getElementById('entnahme-sammel-info');

    const benutzer = entnahmeBenutzerVorlagen.find(item => String(item.id) === String(entnahmeAuswahlBenutzerId));
    const sammel = entnahmeSammelvorlagen.find(item => String(item.id) === String(entnahmeAuswahlSammelId));

    if (benutzerInfo) {
        benutzerInfo.innerHTML = benutzer
            ? `<strong>Ausgewählt:</strong> ${escapeHtml(benutzer.name || '')}<br><small style="color:#56697c;">${escapeHtml(benutzer.kontakt || 'Kein Kontakt gespeichert')}</small>`
            : 'Keine Benutzer-Vorlage ausgewählt.';
    }

    if (sammelInfo) {
        const sammelSelectValue = document.getElementById('entnahme-sammelvorlage')?.value || '';
        const materialAnzahl = Array.isArray(sammel?.materialien) ? sammel.materialien.length : 0;
        if (sammel) {
            sammelInfo.innerHTML = `<strong>Ausgewählt:</strong> ${escapeHtml(sammel.name || '')}<br><small style="color:#6a4a8e;">${materialAnzahl} Material${materialAnzahl === 1 ? '' : 'ien'} gespeichert</small>`;
        } else if (sammelSelectValue === '__new__') {
            sammelInfo.innerHTML = '<strong>Neue Vorlage:</strong> Neue Sammel-Vorlage wird angelegt.';
        } else {
            sammelInfo.innerHTML = '<strong>Standardvorlage aktiv:</strong> Keine Vorlage ausgewählt, es wird eine leere Vorlage verwendet.';
        }
    }
}

function entnahmeVorlagenBearbeitenUmschalten() {
    oeffneVorlagenOverlay();
}

function entnahmeDatumAnzeigen(wert) {
    if (!wert) return '';
    try {
        return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(wert));
    } catch (e) {
        return String(wert);
    }
}

function entnahmeHistorieMaterialLabel(material) {
    const menge = Number(material?.menge) || 0;
    const einheit = material?.einheit || 'Stück';
    return `${menge} ${einheit} ${material?.label || material?.name || 'Material'}`;
}

function entnahmeRueckgabeMengeAuslesen(row) {
    if (!row) return 0;
    const maxMenge = Math.max(0, werteMengeAus(row.getAttribute('data-max-qty')) || 0);
    const input = row.querySelector('[data-role="return-qty"]');
    const menge = werteMengeAus(input?.value);
    return Math.min(Math.max(menge, 0), maxMenge);
}

function entnahmeRueckgabeMengeSetzen(entnahmeId, index, neueMenge) {
    const safeId = String(entnahmeId).replace(/"/g, '');
    const row = document.querySelector(`[data-entnahme-id="${safeId}"] .entnahme-return-row[data-index="${index}"]`);
    if (!row) return;

    const input = row.querySelector('[data-role="return-qty"]');
    if (!input) return;

    const maxMenge = Math.max(0, werteMengeAus(row.getAttribute('data-max-qty')) || 0);
    const clamped = Math.min(Math.max(werteMengeAus(neueMenge) || 0, 0), maxMenge);
    input.value = String(clamped);

    const minusBtn = row.querySelector('.entnahme-return-stepper button[aria-label="Restmenge verringern"]');
    const plusBtn = row.querySelector('.entnahme-return-stepper button[aria-label="Restmenge erhöhen"]');
    if (minusBtn) minusBtn.disabled = clamped <= 0;
    if (plusBtn) plusBtn.disabled = clamped >= maxMenge;
}

function entnahmeRueckgabeMengeAendern(entnahmeId, index, delta) {
    const safeId = String(entnahmeId).replace(/"/g, '');
    const row = document.querySelector(`[data-entnahme-id="${safeId}"] .entnahme-return-row[data-index="${index}"]`);
    if (!row) return;

    const input = row.querySelector('[data-role="return-qty"]');
    if (!input) return;

    const aktuelleMenge = entnahmeRueckgabeMengeAuslesen(row);
    entnahmeRueckgabeMengeSetzen(entnahmeId, index, aktuelleMenge + delta);
}

function entnahmeRueckgabeMengeDirektAendern(entnahmeId, index) {
    const safeId = String(entnahmeId).replace(/"/g, '');
    const row = document.querySelector(`[data-entnahme-id="${safeId}"] .entnahme-return-row[data-index="${index}"]`);
    if (!row) return;

    entnahmeRueckgabeMengeSetzen(entnahmeId, index, entnahmeRueckgabeMengeAuslesen(row));
}

function renderEntnahmeHistorie() {
    const container = document.getElementById('entnahme-historie-liste');
    if (!container) return;

    if (!entnahmeHistorie.length) {
        container.innerHTML = '<p style="color:#666; margin:0;">Noch keine gespeicherten Entnahmen vorhanden.</p>';
        return;
    }

    container.innerHTML = '';
    entnahmeHistorie.forEach(entnahme => {
        const materialien = Array.isArray(entnahme.materialien) ? entnahme.materialien : [];
        const details = document.createElement('details');
        details.className = 'entnahme-history-item';
        details.open = entnahmeHistorieGeoeffnet.has(String(entnahme.id));
        details.dataset.entnahmeId = String(entnahme.id);

        const summary = document.createElement('summary');
        summary.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:4px; text-align:left;">
                <span>${escapeHtml(entnahme.name || 'Ohne Namen')}</span>
                <small style="color:#5f6b77; font-weight:normal;">${escapeHtml(entnahmeDatumAnzeigen(entnahme.created_at))} · ${materialien.length} Position${materialien.length === 1 ? '' : 'en'}</small>
            </div>
        `;
        details.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'entnahme-history-materials';
        body.innerHTML = `
            <div style="color:#5f6b77; line-height:1.45; margin-bottom:10px;">${escapeHtml(entnahme.kontakt || 'Kein Kontakt angegeben')}</div>
            <div>
                ${materialien.map((material, materialIndex) => {
                    const label = escapeHtml(entnahmeHistorieMaterialLabel(material));
                    const rowId = `entnahme-history-${String(entnahme.id).replace(/"/g, '')}-${materialIndex}`;
                    const menge = Math.max(0, Number(material.menge) || 0);
                    return `
                        <div class="entnahme-return-row" data-index="${materialIndex}" data-max-qty="${menge}">
                            <label style="margin:0; font-weight:normal; cursor:pointer; display:flex; align-items:center; gap:8px;"><span aria-hidden="true" style="color:#7f8c8d; font-size:1.2em; line-height:1;">•</span><span>${label}</span></label>
                            <div class="entnahme-return-stepper" title="Aktuelle Restmenge">
                                <button type="button" aria-label="Restmenge verringern" onclick="entnahmeRueckgabeMengeAendern('${String(entnahme.id)}', ${materialIndex}, -1)">−</button>
                                <input type="text" data-role="return-qty" value="${menge}" inputmode="numeric" aria-label="Restmenge" onchange="entnahmeRueckgabeMengeDirektAendern('${String(entnahme.id)}', ${materialIndex})">
                                <button type="button" aria-label="Restmenge erhöhen" onclick="entnahmeRueckgabeMengeAendern('${String(entnahme.id)}', ${materialIndex}, 1)">+</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            <div class="entnahme-history-actions">
                <button class="btn" style="background:#1f5f8b; width:auto;" onclick="entnahmeHistorieLaden('${String(entnahme.id)}')">Laden</button>
                <button class="btn" style="background:#34495e; width:auto;" onclick="entnahmeTeilRueckgabeSpeichern('${String(entnahme.id)}')">Teilrückgabe speichern</button>
                <button class="btn" style="background:#c0392b; width:auto;" onclick="entnahmeKomplettZurueckgeben('${String(entnahme.id)}')">Komplett zurückgeben</button>
            </div>
        `;

        details.appendChild(body);
        details.addEventListener('toggle', () => {
            if (details.open) entnahmeHistorieGeoeffnet.add(String(entnahme.id));
            else entnahmeHistorieGeoeffnet.delete(String(entnahme.id));
        });
        container.appendChild(details);
    });
}

async function ladeEntnahmeHistorie() {
    const result = await dbClient
        .from(ENTNAHME_PROTOKOLL_TABLE)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

    if (result.error) {
        console.warn('Entnahme-Historie konnte nicht geladen werden.', result.error);
        return;
    }

    entnahmeHistorie = result.data || [];
    renderEntnahmeHistorie();
}

function fillEntnahmeVorlagenDropdowns() {
    const benutzerSelect = document.getElementById('entnahme-benutzer-vorlage');
    const sammelSelect = document.getElementById('entnahme-sammelvorlage');
    const benutzerEditSelect = document.getElementById('entnahme-benutzer-vorlage-bearbeiten');
    const sammelEditSelect = document.getElementById('entnahme-sammelvorlage-bearbeiten');

    if (benutzerSelect) {
        const current = benutzerSelect.value;
        benutzerSelect.innerHTML = '<option value="">-- Benutzer auswählen --</option>';
        entnahmeBenutzerVorlagen
            .slice()
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de', { numeric: true, sensitivity: 'base' }))
            .forEach(vorlage => {
                benutzerSelect.add(new Option(vorlage.name, vorlage.id));
            });
        if (Array.from(benutzerSelect.options).some(opt => opt.value === current)) {
            benutzerSelect.value = current;
        }
    }

    if (benutzerEditSelect) {
        const current = benutzerEditSelect.value;
        benutzerEditSelect.innerHTML = '<option value="">-- Neuer Benutzer --</option>';
        entnahmeBenutzerVorlagen
            .slice()
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de', { numeric: true, sensitivity: 'base' }))
            .forEach(vorlage => {
                benutzerEditSelect.add(new Option(vorlage.name, vorlage.id));
            });
        if (Array.from(benutzerEditSelect.options).some(opt => opt.value === current)) {
            benutzerEditSelect.value = current;
        }
    }

    if (sammelSelect) {
        const current = sammelSelect.value;
        sammelSelect.innerHTML = '<option value="">-- Keine Vorlage --</option>';

        // add stored Sammel-Vorlagen
        entnahmeSammelvorlagen
            .slice()
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de', { numeric: true, sensitivity: 'base' }))
            .forEach(vorlage => sammelSelect.add(new Option(vorlage.name, vorlage.id)));

        // add Packlisten as additional selectable options
        if (Array.isArray(packlisten) && packlisten.length) {
            // separator-like option (disabled)
            sammelSelect.add(new Option('──────── Packlisten ────────', '', undefined, undefined));
            packlisten.slice().sort((a,b) => String(a.name||'').localeCompare(String(b.name||''), 'de', { numeric:true })).forEach(pl => {
                // prefix value with pack: to distinguish from normal sammelvorlagen
                sammelSelect.add(new Option(`Packliste: ${pl.name}`, `pack:${pl.id}`));
            });
        }

        if (Array.from(sammelSelect.options).some(opt => opt.value === current)) {
            sammelSelect.value = current;
        }
    }

    if (sammelEditSelect) {
        const current = sammelEditSelect.value;
        sammelEditSelect.innerHTML = '<option value="">-- Vorlage bearbeiten --</option>';

        entnahmeSammelvorlagen
            .slice()
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de', { numeric: true, sensitivity: 'base' }))
            .forEach(vorlage => {
                sammelEditSelect.add(new Option(vorlage.name, vorlage.id));
            });

        if (Array.from(sammelEditSelect.options).some(opt => opt.value === current)) {
            sammelEditSelect.value = current;
        }
    }

    aktualisiereEntnahmeVorlagenInfo();
}

async function ladeEntnahmeVorlagen() {
    const [benutzerRes, sammelRes] = await Promise.all([
        dbClient.from(ENTNAHME_BENUTZER_TABLE).select('*').order('name'),
        dbClient.from(ENTNAHME_SAMMEL_TABLE).select('*').order('name')
    ]);

    if (benutzerRes.error) {
        console.warn('Benutzer-Vorlagen konnten nicht geladen werden.', benutzerRes.error);
    }
    if (sammelRes.error) {
        console.warn('Sammelvorlagen konnten nicht geladen werden.', sammelRes.error);
    }

    entnahmeBenutzerVorlagen = benutzerRes.data || [];
    entnahmeSammelvorlagen = sammelRes.data || [];
    fillEntnahmeVorlagenDropdowns();
}

async function initEntnahmeModus() {
    const entnahmeView = document.getElementById('entnahme-ansicht');
    if (entnahmeView) entnahmeView.style.display = 'block';

    const appContainer = document.querySelector('.container');
    if (appContainer) {
        appContainer.style.background = 'transparent';
        appContainer.style.boxShadow = 'none';
        appContainer.style.maxWidth = '1000px';
        appContainer.style.padding = '0';
        Array.from(appContainer.children).forEach(child => {
            if (child.id === 'entnahme-ansicht') child.style.display = 'block';
            else child.style.display = 'none';
        });
    }

    const appFooter = document.querySelector('.app-footer');
    if (appFooter) appFooter.style.display = '';

    const hoverDate = document.getElementById('hover-date-info');
    const hoverRes = document.getElementById('hover-res-info');
    if (hoverDate) hoverDate.style.display = 'none';
    if (hoverRes) hoverRes.style.display = 'none';

    document.title = 'Lager-Entnahmeprotokoll';

    const localSession = holeLokaleSession();
    if (!localSession) {
        const loginOverlay = document.getElementById('login-overlay');
        if (loginOverlay) loginOverlay.style.display = 'flex';
        setzeEntnahmeSicht(true);
        return;
    }

    setzeAuthToken(localSession.token);

    const loginOverlay = document.getElementById('login-overlay');
    if (loginOverlay) loginOverlay.style.display = 'none';

    setzeEntnahmeSicht(false);
    await ladeAlles();
    aktualisiereEntnahmeMaterialDatalist();
    renderEntnahmeMaterialien();
    await ladeEntnahmeVorlagen();
    await ladeEntnahmeHistorie();
    entnahmeSetzeFormState(entnahmeLadeDraftLokal() || {});
    setzeEntnahmeVorlagenFormSichtbarkeit();
}

async function oeffneEntnahmeFenster() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('entnahme', '1');

    // URL anpassen ohne Neuladen, damit in-memory Session erhalten bleibt
    window.history.replaceState({}, '', url.toString());
    await initEntnahmeModus();
}

function entnahmeBenutzerVorlageAuswaehlen() {
    const selectElement = document.getElementById('entnahme-benutzer-vorlage');
    const vorlagenId = selectElement?.value || '';
    entnahmeBenutzerVorlageInFormenLaden(vorlagenId);

    if (entnahmeWizardAutoAdvanceErlaubt() && vorlagenId) {
        setTimeout(() => entnahmeWizardZuSchritt(2), 180);
    }
}

function entnahmeSammelvorlageAuswaehlen() {
    const selectElement = document.getElementById('entnahme-sammelvorlage');
    const vorlagenId = selectElement?.value || '';
    entnahmeSammelVorlageBestaetigtFuerId = '';

    if (!vorlagenId) {
        entnahmeSammelvorlageInFormenLaden('');
        return;
    }

    const nameFeld = document.getElementById('entnahme-sammelvorlagenname');
    // support selecting a packliste (value prefixed with 'pack:')
    if (vorlagenId && vorlagenId.startsWith('pack:')) {
        const packId = String(vorlagenId).split(':')[1];
        const pl = packlisten.find(p => String(p.id) === String(packId));
        if (nameFeld) nameFeld.value = pl?.name || '';

        const positionen = packlistenPositionen.filter(p => String(p.packliste_id) === String(packId));
        entnahmeMaterialien = positionen.map(p => {
            const art = p.artikel || {};
            return {
                artikel_id: p.artikel_id || art.id || null,
                label: art.name || p.name || '',
                kategorie: art.kategorie || '',
                einheit: art.einheit || p.einheit || 'Stück',
                menge: Number(p.menge) || 0
            };
        });
        renderEntnahmeMaterialien();
        setzeEntnahmeVorlagenFormSichtbarkeit();
        entnahmeMarkiereAutoSaveAlsErforderlich();
        entnahmeWizardAktualisieren();
        entnahmeSammelvorlageAutoSpeichernAnstossen();
        return;
    }

    entnahmeSammelvorlageInFormenLaden(vorlagenId);

    if (entnahmeWizardAutoAdvanceErlaubt() && (vorlagenId || nameFeld?.value.trim())) {
        setTimeout(() => entnahmeWizardZuSchritt(3), 180);
    }
}

function entnahmeBenutzerVorlageNeu() {
    oeffneVorlagenOverlay();
    entnahmeBenutzerVorlageInFormenLaden('');
}

function entnahmeSammelvorlageNeu() {
    oeffneVorlagenOverlay();
    entnahmeSammelvorlageInFormenLaden('');
}

function entnahmeMaterialHinzufuegen() {
    const input = document.getElementById('entnahme-artikel-input');
    const mengeInput = document.getElementById('entnahme-artikel-menge');
    if (!input || !mengeInput) return;

    const label = input.value.trim();
    if (!label) {
        showToast('Bitte zuerst ein Material auswählen.', 'warning');
        return;
    }

    const artikel = alleArtikelInfos.find(item => gibEntnahmeArtikelLabel(item) === label);
    if (!artikel) {
        showToast('Bitte einen Artikel aus der Vorschlagsliste auswählen.', 'warning');
        return;
    }

    const menge = werteMengeAus(mengeInput.value);
    if (menge <= 0) {
        showToast('Bitte eine Menge größer 0 eingeben.', 'warning');
        return;
    }

    const vorhandenerEintrag = entnahmeMaterialien.find(item => String(item.artikel_id) === String(artikel.id));
    if (vorhandenerEintrag) {
        vorhandenerEintrag.menge += menge;
    } else {
        entnahmeMaterialien.push({
            artikel_id: artikel.id,
            label: label,
            kategorie: artikel.kategorie || '',
            einheit: artikel.einheit || 'Stück',
            menge: menge
        });
    }

    input.value = '';
    mengeInput.value = '1';
    renderEntnahmeMaterialien();
    entnahmeMarkiereAutoSaveAlsErforderlich();
    entnahmeWizardAktualisieren();
}

function entnahmeMaterialMengeAendern(index, neueMenge) {
    if (!entnahmeMaterialien[index]) return;

    const menge = werteMengeAus(neueMenge);
    if (menge <= 0) {
        entnahmeMaterialien.splice(index, 1);
    } else {
        entnahmeMaterialien[index].menge = menge;
    }

    renderEntnahmeMaterialien();
    entnahmeMarkiereAutoSaveAlsErforderlich();
    entnahmeWizardAktualisieren();
}

function entnahmeMaterialLoeschen(index) {
    if (!entnahmeMaterialien[index]) return;
    entnahmeMaterialien.splice(index, 1);
    renderEntnahmeMaterialien();
    entnahmeMarkiereAutoSaveAlsErforderlich();
    entnahmeWizardAktualisieren();
}

function entnahmeFormularZuruecksetzen() {
    const nameFeld = document.getElementById('entnahme-name');
    const kontaktFeld = document.getElementById('entnahme-kontakt');
    const benutzerVorlage = document.getElementById('entnahme-benutzer-vorlage');
    const sammelVorlage = document.getElementById('entnahme-sammelvorlage');
    const sammelName = document.getElementById('entnahme-sammelvorlagenname');
    const artikelInput = document.getElementById('entnahme-artikel-input');
    const mengeInput = document.getElementById('entnahme-artikel-menge');

    if (entnahmeAutoSaveTimer) {
        clearTimeout(entnahmeAutoSaveTimer);
        entnahmeAutoSaveTimer = null;
    }

    if (nameFeld) nameFeld.value = '';
    if (kontaktFeld) kontaktFeld.value = '';
    if (benutzerVorlage) benutzerVorlage.value = '';
    if (sammelVorlage) sammelVorlage.value = '';
    if (sammelName) sammelName.value = '';
    if (artikelInput) artikelInput.value = '';
    if (mengeInput) mengeInput.value = '1';

    entnahmeMaterialien = [];
    entnahmeActiveDraftId = '';
    entnahmeAuswahlBenutzerId = '';
    entnahmeAuswahlSammelId = '';
    entnahmeBenutzerNeuAktiv = false;
    entnahmeSammelNeuAktiv = false;
    entnahmeWizardZuSchritt(1);
    entnahmeLoescheDraftLokal();
    renderEntnahmeMaterialien();
}

async function entnahmeBenutzerVorlageSpeichern() {
    const name = document.getElementById('entnahme-name')?.value.trim() || '';
    const kontakt = document.getElementById('entnahme-kontakt')?.value.trim() || '';
    const bestehendeId = entnahmeAuswahlBenutzerId || document.getElementById('entnahme-benutzer-vorlage-bearbeiten')?.value || document.getElementById('entnahme-benutzer-vorlage')?.value || '';
    const normName = name.toLowerCase();

    console.log('entnahmeBenutzerVorlageSpeichern called', { name, kontakt, bestehendeId });
    showToast('Speichere Benutzer-Vorlage...', 'success');

    if (!name) {
        if (!bestehendeId) {
            showToast('Bitte zuerst einen Namen eingeben.', 'warning');
            return;
        }

        if (!confirm('Der Name der Benutzer-Vorlage ist leer. Soll diese Vorlage gelöscht werden?')) {
            return;
        }

        const loeschRes = await dbClient.from(ENTNAHME_BENUTZER_TABLE).delete().eq('id', bestehendeId);
        if (loeschRes.error) {
            showToast('Benutzer-Vorlage konnte nicht gelöscht werden.', 'error');
            console.error('Supabase error deleting benutzer vorlage:', loeschRes.error);
            return;
        }

        entnahmeAuswahlBenutzerId = '';
        entnahmeBenutzerNeuAktiv = false;
        const selectElement = document.getElementById('entnahme-benutzer-vorlage');
        if (selectElement) selectElement.value = '';
        const editSelect = document.getElementById('entnahme-benutzer-vorlage-bearbeiten');
        if (editSelect) editSelect.value = '';
        const nameFeld = document.getElementById('entnahme-name');
        const kontaktFeld = document.getElementById('entnahme-kontakt');
        if (nameFeld) nameFeld.value = '';
        if (kontaktFeld) kontaktFeld.value = '';

        showToast('Benutzer-Vorlage gelöscht.');
        await ladeEntnahmeVorlagen();
        setzeEntnahmeVorlagenFormSichtbarkeit();
        return;
    }

    const doppelteVorlage = entnahmeBenutzerVorlagen.find(vorlage =>
        String(vorlage.id) !== String(bestehendeId) &&
        String(vorlage.name || '').trim().toLowerCase() === normName
    );

    if (doppelteVorlage) {
        showToast('Benutzer-Vorlage mit diesem Namen existiert bereits und konnte nicht angelegt werden.', 'error');
        return;
    }

    try {
        const payload = { name, kontakt };
        const res = bestehendeId
            ? await dbClient.from(ENTNAHME_BENUTZER_TABLE).update(payload).eq('id', bestehendeId).select()
            : await dbClient.from(ENTNAHME_BENUTZER_TABLE).insert([payload]).select();

        if (res.error) {
            showToast('Benutzer-Vorlage konnte nicht gespeichert werden.', 'error');
            console.error('Supabase error saving benutzer vorlage:', res.error);
            return;
        }

        if (res.data && res.data[0]?.id) {
            entnahmeAuswahlBenutzerId = String(res.data[0].id);
            const selectElement = document.getElementById('entnahme-benutzer-vorlage');
            if (selectElement) selectElement.value = entnahmeAuswahlBenutzerId;
            const editSelect = document.getElementById('entnahme-benutzer-vorlage-bearbeiten');
            if (editSelect) editSelect.value = entnahmeAuswahlBenutzerId;
        }

        showToast('Benutzer-Vorlage gespeichert.');
        await ladeEntnahmeVorlagen();
        entnahmeBenutzerVorlageInFormenLaden(entnahmeAuswahlBenutzerId);
    } catch (e) {
        showToast('Fehler beim Speichern der Vorlage.', 'error');
        console.error('Exception in entnahmeBenutzerVorlageSpeichern:', e);
    }
}

async function entnahmeSammelvorlageSpeichern() {
    return entnahmeSammelvorlageAutoSpeichern();
}

async function entnahmeHistorieLaden(entnahmeId) {
    const entnahme = entnahmeHistorie.find(item => String(item.id) === String(entnahmeId));
    if (!entnahme) return;

    const nameFeld = document.getElementById('entnahme-name');
    const kontaktFeld = document.getElementById('entnahme-kontakt');
    const benutzerSelect = document.getElementById('entnahme-benutzer-vorlage');
    const sammelSelect = document.getElementById('entnahme-sammelvorlage');

    if (nameFeld) nameFeld.value = entnahme.name || '';
    if (kontaktFeld) kontaktFeld.value = entnahme.kontakt || '';
    if (benutzerSelect) benutzerSelect.value = entnahme.benutzer_vorlage_id || '';
    if (sammelSelect) sammelSelect.value = entnahme.sammelvorlage_id || '';
    entnahmeActiveDraftId = String(entnahme.id);

    entnahmeMaterialien = Array.isArray(entnahme.materialien)
        ? entnahme.materialien.map(item => ({ ...item }))
        : [];
    renderEntnahmeMaterialien();
    setzeEntnahmeVorlagenFormSichtbarkeit();
    entnahmeWizardZuSchritt(3);
    entnahmeMarkiereAutoSaveAlsErforderlich();
    showToast('Entnahme in Formular geladen.');
}

function entnahmeRueckgabeMaterialienAuslesen(entnahmeId) {
    const safeId = String(entnahmeId).replace(/"/g, '');
    const details = document.querySelector(`[data-entnahme-id="${safeId}"]`);
    if (!details) return [];

    const rows = details.querySelectorAll('.entnahme-return-row');
    const rueckgaenge = [];

    rows.forEach(row => {
        const index = Number(row.dataset.index);
        const menge = entnahmeRueckgabeMengeAuslesen(row);
        if (index >= 0 && menge >= 0) {
            rueckgaenge.push({ index, menge });
        }
    });

    return rueckgaenge;
}

async function entnahmeTeilRueckgabeSpeichern(entnahmeId) {
    const entnahme = entnahmeHistorie.find(item => String(item.id) === String(entnahmeId));
    if (!entnahme) return;

    const rueckgaenge = entnahmeRueckgabeMaterialienAuslesen(entnahmeId);
    if (rueckgaenge.length === 0) {
        showToast('Bitte mindestens ein Material für die Rückgabe auswählen.', 'warning');
        return;
    }

    const neueMaterialien = Array.isArray(entnahme.materialien)
        ? entnahme.materialien.map(item => ({ ...item }))
        : [];

    rueckgaenge.sort((a, b) => b.index - a.index).forEach(({ index, menge }) => {
        const material = neueMaterialien[index];
        if (!material) return;

        material.menge = Math.max(0, Number(menge) || 0);

        if (material.menge <= 0) {
            neueMaterialien.splice(index, 1);
        }
    });

    if (neueMaterialien.length === 0) {
        const loeschRes = await dbClient.from(ENTNAHME_PROTOKOLL_TABLE).delete().eq('id', entnahmeId);
        if (loeschRes.error) {
            showToast('Rückgabe konnte nicht gespeichert werden.', 'error');
            console.error(loeschRes.error);
            return;
        }

        showToast('Entnahme vollständig zurückgegeben und entfernt.');
    } else {
        const { error } = await dbClient
            .from(ENTNAHME_PROTOKOLL_TABLE)
            .update({ materialien: neueMaterialien })
            .eq('id', entnahmeId);

        if (error) {
            showToast('Rückgabe konnte nicht gespeichert werden.', 'error');
            console.error(error);
            return;
        }

        showToast('Teilrückgabe gespeichert.');
    }

    await ladeEntnahmeHistorie();
}

async function entnahmeKomplettZurueckgeben(entnahmeId) {
    const entnahme = entnahmeHistorie.find(item => String(item.id) === String(entnahmeId));
    if (!entnahme) return;

    if (!confirm(`Die Entnahme "${entnahme.name || 'ohne Namen'}" wirklich komplett zurückgeben und entfernen?`)) return;

    const { error } = await dbClient.from(ENTNAHME_PROTOKOLL_TABLE).delete().eq('id', entnahmeId);
    if (error) {
        showToast('Entnahme konnte nicht entfernt werden.', 'error');
        console.error(error);
        return;
    }

    showToast('Entnahme entfernt.');
    await ladeEntnahmeHistorie();
}

async function entnahmeProtokollSpeichern(options = {}) {
    const { silent = false, finalize = true } = options;

    if (!finalize) {
        entnahmeSpeichereDraftLokal();
        return null;
    }

    const name = document.getElementById('entnahme-name')?.value.trim() || '';
    const kontakt = document.getElementById('entnahme-kontakt')?.value.trim() || '';
    const benutzerVorlageId = document.getElementById('entnahme-benutzer-vorlage')?.value || null;
    let sammelvorlageId = document.getElementById('entnahme-sammelvorlage')?.value || null;

    if (sammelvorlageId && String(sammelvorlageId).startsWith('pack:')) {
        sammelvorlageId = null;
    }

    if (!name || entnahmeMaterialien.length === 0) {
        if (!silent) {
            if (!name) showToast('Bitte einen Namen eingeben.', 'warning');
            else showToast('Bitte mindestens ein Material auswählen.', 'warning');
        }
        return null;
    }

    const payload = {
        name,
        kontakt,
        materialien: entnahmeMaterialien.map(item => ({ ...item })),
        benutzer_vorlage_id: benutzerVorlageId,
        sammelvorlage_id: sammelvorlageId
    };

    let savedId = entnahmeActiveDraftId ? String(entnahmeActiveDraftId) : '';

    try {
        let result;
        if (savedId) {
            result = await dbClient.from(ENTNAHME_PROTOKOLL_TABLE).update(payload).eq('id', savedId).select();
            if (result.error) {
                console.warn('Bestehender Entnahme-Entwurf konnte nicht aktualisiert werden, versuche Neu-Anlage.', result.error);
                savedId = '';
            }
        }

        if (!savedId) {
            result = await dbClient.from(ENTNAHME_PROTOKOLL_TABLE).insert([payload]).select();
            if (result.error) {
                throw result.error;
            }
            savedId = result.data && result.data[0] ? String(result.data[0].id) : '';
        }

        entnahmeActiveDraftId = savedId;

        try {
            const auditPayload = {
                entnahme_id: savedId || null,
                name,
                kontakt,
                materialien: payload.materialien,
                benutzer_vorlage_id: benutzerVorlageId,
                sammelvorlage_id: sammelvorlageId
            };
            const { error: auditError } = await dbClient.from(ENTNAHME_AUDIT_TABLE).insert([auditPayload]);
            if (auditError) console.warn('Audit-Eintrag konnte nicht gespeichert werden:', auditError);
        } catch (e) {
            console.error('Fehler beim Schreiben des Audit-Eintrags:', e);
        }

        if (!silent) {
            showToast('Entnahme abgeschlossen.');
        }

        entnahmeLoescheDraftLokal();
        if (entnahmeAutoSaveTimer) {
            clearTimeout(entnahmeAutoSaveTimer);
            entnahmeAutoSaveTimer = null;
        }

        entnahmeFormularZuruecksetzen();
        return savedId;
    } catch (error) {
        if (!silent) {
            showToast('Entnahme konnte nicht gespeichert werden.', 'error');
        }
        console.error(error);
        return null;
    }
}

async function entnahmeAbschliessen() {
    return entnahmeProtokollSpeichern({ finalize: true });
}

async function zurHauptseiteZurueck(nachSpeichern = false) {
    const url = new URL(window.location.href);
    url.searchParams.delete('entnahme');
    if (/\/index\.html?$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/index\.html?$/i, '/');
    }

    // Einen echten Neustart des Hauptbereichs erzwingen, damit die Seite exakt
    // so initialisiert wird wie bei einem frischen Aufruf.
    window.location.replace(url.toString());
}

function escapeHtml(input) {
    return String(input || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', async () => {
    initFormularLink();
    initEntnahmeLink();

    if (QRGEN_MODUS) {
        initQrGenModus();
        return;
    }

    if (ENTNAHME_MODUS) {
        await initEntnahmeModus();
        return;
    }

    initRegalQrTool();

    if (FORMULAR_MODUS) {
        initFormularModus();
        return;
    }

    const localSession = holeLokaleSession();
    if (localSession) { 
        setzeAuthToken(localSession.token);
        document.getElementById('login-overlay').style.display = 'none'; 
        ladeAlles(); 
        pruefeUndZeigeOnboarding(); 
    } else { 
        document.getElementById('login-overlay').style.display = 'flex'; 
    }
});

/*
dbClient.auth.onAuthStateChange(async (event, session) => {
    if (FORMULAR_MODUS || QRGEN_MODUS) return;
    const overlay = document.getElementById('login-overlay');
    if (ENTNAHME_MODUS) {
        await initEntnahmeModus();
        return;
    }
    if (event === 'SIGNED_IN') { overlay.style.display = 'none'; showToast('Erfolgreich angemeldet!'); ladeAlles(); pruefeUndZeigeOnboarding(); } 
    else if (event === 'SIGNED_OUT') {
        overlay.style.display = 'flex';
        document.getElementById('lager-tabelle').innerHTML = ''; 
    }
});
*/

const ONBOARDING_STORAGE_KEY = 'lager_onboarding_v1_gesehen';

// Beobachtet automatisch alle Modal-Fenster und ergänzt/entfernt die Klasse
// 'modal-visible', sobald sie ein-/ausgeblendet werden. Dadurch bekommen ALLE
// Modals im Projekt eine sanfte Fade-/Scale-Animation, ohne dass jede einzelne
// öffnende/schließende Funktion im Code angepasst werden muss.
function initModalUebergaenge() {
    document.querySelectorAll('.modal').forEach(modal => {
        const beobachter = new MutationObserver(() => {
            const sichtbar = getComputedStyle(modal).display !== 'none';
            if (sichtbar) {
                requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('modal-visible')));
            } else {
                modal.classList.remove('modal-visible');
            }
        });
        beobachter.observe(modal, { attributes: true, attributeFilter: ['style'] });
    });
}
document.addEventListener('DOMContentLoaded', initModalUebergaenge);

function pruefeUndZeigeOnboarding() {
    try {
        if (window.localStorage.getItem(ONBOARDING_STORAGE_KEY)) return;
    } catch (e) { /* localStorage evtl. nicht verfügbar, dann einfach anzeigen */ }
    oeffneOnboarding();
}

function oeffneOnboarding() {
    const modal = document.getElementById('onboardingModal');
    if (modal) modal.style.display = 'block';
}

function schliesseOnboarding() {
    const modal = document.getElementById('onboardingModal');
    if (modal) modal.style.display = 'none';
    try { window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1'); } catch (e) { /* ignorieren */ }
}

async function handleLogin() {
    const p = document.getElementById('login-password').value;
    const now = Date.now();
    const lockUntil = holeLoginSperreBis();

    if (lockUntil > now) {
        const remainingSeconds = Math.ceil((lockUntil - now) / 1000);
        const loginError = document.getElementById('login-error');
        if (loginError) {
            loginError.innerText = `Zu viele Fehlversuche. Bitte in ${remainingSeconds} Sekunden erneut versuchen.`;
            loginError.style.display = 'block';
        }
        return;
    }

    const { data, error } = await dbClient.rpc('login_user', { p_password: p });

    if (error || !data || data.length === 0) {
        const gesperrtBis = fuegeLoginFehlversuchHinzu();
        const loginError = document.getElementById('login-error');
        if (loginError) {
            loginError.style.display = 'block';
            if (gesperrtBis > Date.now()) {
                const remainingSeconds = Math.ceil((gesperrtBis - Date.now()) / 1000);
                loginError.innerText = `Zu viele Fehlversuche. Bitte in ${remainingSeconds} Sekunden erneut versuchen.`;
            } else {
                loginError.innerText = 'Falsches Passwort!';
            }
        }
    } else {
        const loginError = document.getElementById('login-error');
        if (loginError) loginError.style.display = 'none';
        document.getElementById('login-password').value = '';
        document.getElementById('login-overlay').style.display = 'none';
        
        setzeLoginFehlversucheZurueck();
        speichereLokaleSession({ username: data.username, token: data.token });
        
        showToast('Erfolgreich angemeldet!');
        ladeAlles();
        pruefeUndZeigeOnboarding();
    }
}

async function handleLogout() {
    loescheLokaleSession();
    setzeAuthToken(null);
    setzeLoginFehlversucheZurueck();
    document.getElementById('login-overlay').style.display = 'flex';
    document.getElementById('lager-tabelle').innerHTML = '';
    showToast('Abgemeldet.');
}

function openRechtliches(event, modalId) {
    event.preventDefault();
    document.getElementById(modalId).style.display = 'block';
}

function wechsleModus(modus) {
    aktuellerModus = modus;
    const lagerAnsicht = document.getElementById('ansicht-lager');
    const eventAnsicht = document.getElementById('ansicht-event');

    lagerAnsicht.style.display = modus === 'lager' ? 'block' : 'none';
    eventAnsicht.style.display = modus === 'event' ? 'block' : 'none';

    const sichtbareAnsicht = modus === 'lager' ? lagerAnsicht : eventAnsicht;
    sichtbareAnsicht.classList.remove('view-fade-in');
    void sichtbareAnsicht.offsetWidth; // Reflow erzwingen, damit die Animation bei jedem Wechsel neu startet
    sichtbareAnsicht.classList.add('view-fade-in');

    document.getElementById('tab-lager').className = modus === 'lager' ? 'btn btn-modus active' : 'btn btn-modus';
    document.getElementById('tab-event').className = modus === 'event' ? 'btn btn-modus active' : 'btn btn-modus';
    
    if (modus === 'event') ladeEventDaten();
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function openModal() { 
    document.getElementById('new-name').value = '';
    document.getElementById('new-kategorie').value = '';
    document.getElementById('new-einheit').value = 'Stück';
    const newWichtig = document.getElementById('new-wichtig');
    if (newWichtig) newWichtig.checked = false;
    
    const container = document.getElementById('new-orte-wrapper');
    const rows = container.querySelectorAll('.lagerort-row');
    for(let i = 1; i < rows.length; i++) {
        rows[i].remove();
    }
    
    const firstRow = rows[0];
    const firstInput = firstRow.querySelector('.new-menge');
    firstInput.value = '0';
    firstInput.disabled = false;
    firstInput.removeAttribute('data-old-value'); 
    aktualisiereMengeEingabeFarbe(firstInput);
    setzeBestandStatus(firstRow, 'zahl');

    const firstSelect = firstRow.querySelector('.new-ort');
    const defaultOrt = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
    if (defaultOrt && firstSelect) {
        firstSelect.value = defaultOrt.id;
    }
    
    document.getElementById('artikelModal').style.display = 'block'; 
}

function addOrtRow() {
    const container = document.getElementById('new-orte-wrapper');
    const firstRow = container.querySelector('.lagerort-row');
    const newRow = firstRow.cloneNode(true); 

    const input = newRow.querySelector('.new-menge');
    input.value = '0';
    input.disabled = false;
    input.removeAttribute('data-old-value'); 
    aktualisiereMengeEingabeFarbe(input);
    setzeBestandStatus(newRow, 'zahl');

    const newSelect = newRow.querySelector('.new-ort');
    const defaultOrt = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
    if (defaultOrt && newSelect) {
        newSelect.value = defaultOrt.id;
    }

    container.appendChild(newRow);
}

function removeNewOrtRow(btn) {
    const wrapper = document.getElementById('new-orte-wrapper');
    if (wrapper.querySelectorAll('.lagerort-row').length > 1) {
        btn.closest('.lagerort-row').remove();
    } else {
        showToast("Ein Artikel muss mindestens einen Lagerort haben!", "warning");
    }
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
    if(aktuellerModus === 'event') await ladeEventDaten();
}
async function ladeLagerorte() {
    const { data } = await dbClient.from('lagerorte').select('*').order('name');
    if (data) {
        alleLagerorte = data; 

        const selectsNeu = document.querySelectorAll('.new-ort');
        const selectEdit = document.getElementById('edit-ort');
        
        selectsNeu.forEach(sel => sel.innerHTML = ''); 
        if(selectEdit) selectEdit.innerHTML = '';

        data.forEach(o => {
            selectsNeu.forEach(sel => sel.add(new Option(o.name, o.id)));
            if(selectEdit) selectEdit.add(new Option(o.name, o.id));
        });


        const defaultOrt = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
        if (defaultOrt) {
            selectsNeu.forEach(sel => sel.value = defaultOrt.id);
        }
    }
}

async function ladeBestand() {
    const { data: alleArt } = await dbClient.from('artikel').select('*').order('name');
    alleArtikelInfos = alleArt || [];
    let { data, error } = await dbClient.from('bestand')
        .select(`id, menge, alte_menge, created_at, artikel_id, lagerort_id, artikel (id, name, kategorie, einheit, kommentar), lagerorte (id, name)`).order('id');
    
    if (error) {
        console.warn("Spalte created_at fehlt in Supabase. Lade ohne Datum.");
        const fallback = await dbClient.from('bestand')
            .select(`id, menge, alte_menge, artikel_id, lagerort_id, artikel (id, name, kategorie, einheit, kommentar), lagerorte (id, name)`).order('id');
        data = fallback.data;
        if (fallback.error) { showToast("Datenbank-Fehler", "error"); return; }
    }

    const wichtigMap = new Map(alleArtikelInfos.map(art => [String(art.id), Boolean(art.wichtig)]));
    aktuelleDaten = (data || []).map(zeile => ({
        ...zeile,
        artikel: zeile.artikel ? { ...zeile.artikel, wichtig: wichtigMap.get(String(zeile.artikel_id)) || Boolean(zeile.artikel.wichtig) } : zeile.artikel
    })); 
    aktualisiereFilterDropdown(aktuelleDaten); 
    wendeFilterAn(); 
    aktualisiereEntnahmeMaterialDatalist();
}

function aktualisiereFilterDropdown(daten) {
    const dropdown = document.getElementById('kategorie-filter');
    const datalist = document.getElementById('kategorie-liste');
    const regalDropdown = document.getElementById('regal-filter-select');
    
    const kategorien = new Set();
    const regale = new Set();
    
    daten.forEach(z => { 
        if (z.artikel && z.artikel.kategorie && z.artikel.kategorie.trim() !== '') {
            kategorien.add(z.artikel.kategorie.trim()); 
        }
        const regalName = extrahiereRegalName(z.lagerorte?.name || '');
        if (regalName) {
            regale.add(regalName);
        }
    });

    if (dropdown) {
        const aktuelleAuswahl = dropdown.value;
        dropdown.innerHTML = '<option value="ALLE">Alle Kategorien</option>';
        Array.from(kategorien).sort().forEach(kat => dropdown.add(new Option(kat, kat)));
        if (Array.from(dropdown.options).some(opt => opt.value === aktuelleAuswahl)) dropdown.value = aktuelleAuswahl;
    }

    if (regalDropdown) {
        const aktuelleRegalAuswahl = aktiverRegalFilter || regalDropdown.value;
        regalDropdown.innerHTML = '<option value="">Alle Regale</option>';
        Array.from(regale).sort((a,b) => vergleicheRegalNamen(a, b)).forEach(reg => regalDropdown.add(new Option('Regal: ' + reg, reg)));
        if (Array.from(regalDropdown.options).some(opt => opt.value === aktuelleRegalAuswahl)) {
            regalDropdown.value = aktuelleRegalAuswahl;
        }
    }
    const comboDropdown = document.getElementById('ort-filter-combo');
    if (comboDropdown) {
        const aktuelleComboAuswahl = aktiverRegalFilter ? 'regal:' + aktiverRegalFilter : comboDropdown.value;
        comboDropdown.innerHTML = '<option value="">Alle Orte</option>';
        
        Array.from(alleLagerorte).sort((a,b) => a.name.localeCompare(b.name, 'de')).forEach(ort => {
            comboDropdown.add(new Option('📍 ' + ort.name, 'ort:' + ort.id));
        });
        
        Array.from(regale).sort((a,b) => vergleicheRegalNamen(a, b)).forEach(reg => {
            comboDropdown.add(new Option('🏷️ Regal: ' + reg, 'regal:' + reg));
        });
        
        if (Array.from(comboDropdown.options).some(opt => opt.value === aktuelleComboAuswahl)) {
            comboDropdown.value = aktuelleComboAuswahl;
        }
    }

    if (datalist) {
        datalist.innerHTML = '';
        Array.from(kategorien).sort().forEach(kat => {
            const option = document.createElement('option');
            option.value = kat;
            datalist.appendChild(option);
        });
    }
}

function wendeFilterAn() {
    const katFilter = document.getElementById('kategorie-filter')?.value || 'ALLE';
    const comboFilter = document.getElementById('ort-filter-combo')?.value || '';
    const suchText = document.getElementById('such-filter')?.value.toLowerCase().trim() || '';
    
    let ortFilter = 'ALLE';
    let regalFilterTemp = '';
    if (comboFilter.startsWith('ort:')) {
        ortFilter = comboFilter.substring(4);
    } else if (comboFilter.startsWith('regal:')) {
        regalFilterTemp = comboFilter.substring(6);
    }
    
    let gefilterteDaten = aktuelleDaten;

    if (suchText !== '') {
        gefilterteDaten = gefilterteDaten.filter(z => 
            (z.artikel?.name || '').toLowerCase().includes(suchText) ||
            (z.artikel?.kategorie || '').toLowerCase().includes(suchText) ||
            (z.lagerorte?.name || '').toLowerCase().includes(suchText)
        );
    }

    if (regalFilterTemp !== '') {
        aktiverRegalFilter = regalFilterTemp;
    } else if (comboFilter.startsWith('ort:') || comboFilter === '') {
        aktiverRegalFilter = '';
    }
    if (aktiverRegalFilter !== '') {
        gefilterteDaten = gefilterteDaten.filter(z => {
            const suchfelder = [
                z.artikel?.name || '',
                z.artikel?.kategorie || '',
                z.lagerorte?.name || ''
            ];

            return suchfelder.some(text => textEnthaeltRegal(text, aktiverRegalFilter));
        });
    }

    if (katFilter !== 'ALLE') gefilterteDaten = gefilterteDaten.filter(z => z.artikel && z.artikel.kategorie === katFilter);
    if (ortFilter !== 'ALLE') gefilterteDaten = gefilterteDaten.filter(z => String(z.lagerort_id) === String(ortFilter));

    tabelleAktualisieren(gefilterteDaten);
}

function toggleSortierung() {
    sortAscending = !sortAscending;
    const btn = document.getElementById('btn-sort');
    if (btn) btn.innerText = sortAscending ? 'A-Z' : 'Z-A';
    wendeFilterAn();
}

function toggleGruppe(name) {
    if (offeneGruppen.has(name)) offeneGruppen.delete(name);
    else offeneGruppen.add(name);
    wendeFilterAn();
}

function toggleAlleGruppen() {
    isAllOpen = !isAllOpen;
    offeneGruppen.clear();
    if (isAllOpen) aktuelleDaten.forEach(z => { if (z.artikel) offeneGruppen.add(z.artikel.kategorie || 'Ohne Kategorie'); });
    wendeFilterAn();
}

function tabelleAktualisieren(daten) {
    const tbody = document.getElementById('lager-tabelle');
    if (!tbody) return;
    tbody.innerHTML = ''; 
    
    const suchText = document.getElementById('such-filter')?.value.trim() || '';
    const isSearching = suchText.length > 0 || aktiverRegalFilter !== '';
    
    const reservierungenDetails = {};
    packlistenPositionen.forEach(p => {
        if(p.artikel_id) {
            if (!reservierungenDetails[p.artikel_id]) {
                reservierungenDetails[p.artikel_id] = { gesamt: 0, listen: {} };
            }
            reservierungenDetails[p.artikel_id].gesamt += Number(p.menge);
            
            const pl = packlisten.find(list => String(list.id) === String(p.packliste_id));
            const plName = pl ? pl.name : 'Unbekannte Liste';
            
            reservierungenDetails[p.artikel_id].listen[plName] = (reservierungenDetails[p.artikel_id].listen[plName] || 0) + Number(p.menge);
        }
    });

    const anzeigeDaten = (zeigeAlleArtikel || aktiverRegalFilter !== '') ? daten : daten.filter(zeile => zeile.artikel && zeile.artikel.wichtig);
    const gruppierteDaten = {}; 
    anzeigeDaten.forEach(zeile => {
        if (!zeile.artikel) return; 
        const katName = zeile.artikel.kategorie || 'Ohne Kategorie';
        if (!gruppierteDaten[katName]) { gruppierteDaten[katName] = []; }
        gruppierteDaten[katName].push(zeile); 
    });

    const sortFactor = sortAscending ? 1 : -1;
    const sortedKategorien = Object.keys(gruppierteDaten).sort((a, b) => {
        const specialFolder = 'Ohne Kategorie';
        if (a === specialFolder) return 1;
        if (b === specialFolder) return -1;
        return a.localeCompare(b, 'de') * sortFactor;
    });

    if (anzeigeDaten.length === 0) {
        const emptyTr = document.createElement('tr');
        emptyTr.innerHTML = `
            <td colspan="3" style="text-align:center; padding:24px; color:#666;">
                ${zeigeAlleArtikel ? 'Keine Artikel vorhanden.' : 'Keine markierten Artikel sichtbar.'}
            </td>
        `;
        tbody.appendChild(emptyTr);
    }
    
    for (const katName of sortedKategorien) {
        const zeilenListe = gruppierteDaten[katName];
        
        const isOpen = offeneGruppen.has(katName) || isSearching;
        const icon = isOpen ? '📂' : '📁';

        let ordnerSumme = 0;
        let hatUnendlich = false;
        zeilenListe.forEach(z => {
            if(Number(z.menge) === -1) hatUnendlich = true;
            else if(Number(z.menge) >= 0) ordnerSumme += Number(z.menge);
        });
        
        let summenAnzeige = ordnerSumme;
        if(hatUnendlich && ordnerSumme > 0) summenAnzeige = `${ordnerSumme} + ∞`;
        else if(hatUnendlich && ordnerSumme === 0) summenAnzeige = `∞`;

        const headerTr = document.createElement('tr');
        headerTr.style.cursor = 'pointer';
        headerTr.onclick = () => toggleGruppe(katName);
        
        headerTr.innerHTML = `
            <td colspan="3" style="background-color: #e2e8f0; color: #2c3e50; font-weight: bold; padding: 12px; user-select: none;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span>${icon} ${escapeHtml(katName)}</span>
                    <span class="summen-badge">Gesamt: ${summenAnzeige}</span>
                </div>
            </td>
        `;
        tbody.appendChild(headerTr);

        if (!isOpen) continue;

        const prefixCounts = {};
        const prefixSums = {};
        const prefixInf = {};
        
        zeilenListe.forEach(z => {
            const parts = z.artikel.name.trim().split(' ');
            if (parts.length > 1) { 
                const prefix = parts[0];
                prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
                
                if (!prefixSums[prefix]) prefixSums[prefix] = 0;
                if (Number(z.menge) === -1) {
                    prefixInf[prefix] = true;
                } else if (Number(z.menge) >= 0) {
                    prefixSums[prefix] += Number(z.menge);
                }
            }
        });

        zeilenListe.sort((a, b) => {
            const regalCmp = vergleicheRegalNamen(a.lagerorte?.name || '', b.lagerorte?.name || '', sortFactor);
            if (regalCmp !== 0) return regalCmp;

            const aName = a.artikel.name.trim();
            const bName = b.artikel.name.trim();
            const aParts = aName.split(' ');
            const bParts = bName.split(' ');
            const aPrefix = aParts.length > 1 && prefixCounts[aParts[0]] > 1 ? aParts[0] : aName;
            const bPrefix = bParts.length > 1 && prefixCounts[bParts[0]] > 1 ? bParts[0] : bName;

            const cmp = aPrefix.localeCompare(bPrefix, 'de') * sortFactor;
            if (cmp !== 0) return cmp;
            return aName.localeCompare(bName, 'de') * sortFactor;
        });

        let currentPrefix = null;
        const artikelGruppen = new Map();
        zeilenListe.forEach(z => {
            if (!artikelGruppen.has(z.artikel_id)) {
                artikelGruppen.set(z.artikel_id, {
                    artikel: z.artikel,
                    bestaende: []
                });
            }
            artikelGruppen.get(z.artikel_id).bestaende.push(z);
        });

        const gruppenSortiert = Array.from(artikelGruppen.entries()).map(([artId, gruppe]) => ({
            artId,
            gruppe,
            sortRegal: ermittleRegalSchluessel(gruppe.bestaende),
            sortName: gruppe.artikel.name.trim()
        })).sort((a, b) => {
            const regalCmp = vergleicheRegalNamen(a.sortRegal, b.sortRegal, sortFactor);
            if (regalCmp !== 0) return regalCmp;
            return a.sortName.localeCompare(b.sortName, 'de', { numeric: true, sensitivity: 'base' }) * sortFactor;
        });

        gruppenSortiert.forEach(({ gruppe, artId }) => {
            gruppe.bestaende.sort((a, b) => vergleicheRegalNamen(a.lagerorte?.name || '', b.lagerorte?.name || '', sortFactor));

            const aName = gruppe.artikel.name.trim();
            const parts = aName.split(' ');
            const isGroup = parts.length > 1 && prefixCounts[parts[0]] > 1;
            const prefix = isGroup ? parts[0] : null;

            if (isGroup && currentPrefix !== prefix) {
                let pSum = prefixSums[prefix] || 0;
                let pInf = prefixInf[prefix] || false;
                let pSumAnzeige = pSum;
                
                if (pInf && pSum > 0) pSumAnzeige = `${pSum} + ∞`;
                else if (pInf && pSum === 0) pSumAnzeige = `∞`;

                const subGroupTr = document.createElement('tr');
                subGroupTr.innerHTML = `
                    <td colspan="3" style="padding-left: 25px; background: #fafafa; color: #7f8c8d; font-size: 0.85em; font-weight: bold; border-bottom: 1px dashed #ddd; user-select: none;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span>🏷️ ${escapeHtml(prefix)}</span>
                            <span class="sub-sum-badge">Gesamt: ${pSumAnzeige}</span>
                        </div>
                    </td>`;
                tbody.appendChild(subGroupTr);
                currentPrefix = prefix;
            } else if (!isGroup) {
                currentPrefix = null;
            }

            const tr = document.createElement('tr');
            tr.style.cursor = isEditMode ? "pointer" : "default";

            tr.onclick = (e) => { 
                if(hoverWasLongPress) return;
                if(e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') openEditModal(artId); 
            };

            let displayName = gruppe.artikel.name;
            let indent = 25;
            let iconLabel = '↳';
            const wichtigBadge = gruppe.artikel.wichtig ? '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; background:#f39c12; color:#fff; font-size:0.75em; font-weight:bold; vertical-align:middle;">MARKIERT</span>' : '';
            const hatKommentar = gruppe.artikel.kommentar && gruppe.artikel.kommentar.trim() !== '';
            const bubbleColor = hatKommentar ? '#3498db' : '#bdc3c7'; 
            const bubbleFill = hatKommentar ? '#3498db' : 'none'; 
            const bubbleOpacity = hatKommentar ? '1' : '0.5'; 
            
            const kommentarText = (gruppe.artikel.kommentar || '').trim();
            const kommentarIcon = isEditMode ? `
                <span onclick="openKommentarModal('${artId}', event)" style="cursor: pointer; margin-left: 8px; vertical-align: middle; opacity: ${bubbleOpacity}; display: inline-block; padding-top: 2px;" title="${hatKommentar ? 'Kommentar ansehen/bearbeiten' : 'Kommentar hinzufügen'}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="${bubbleFill}" stroke="${bubbleColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                    </svg>
                </span>` : '';
            const kommentarAnzeige = !isEditMode && hatKommentar ? `
                <div style="margin-top: 4px; color: #7f8c8d; font-size: 0.78em; font-weight: normal; line-height: 1.35; display: flex; align-items: flex-start; gap: 5px; padding-left: 18px;">
                    <span style="flex: 0 0 auto; opacity: 0.85;">💬</span>
                    <span style="min-width: 0; white-space: pre-wrap; word-break: break-word;">${escapeHtml(kommentarText)}</span>
                </div>` : '';
            if (isGroup) {
                indent = 45;
                iconLabel = '◦';
                displayName = displayName.substring(prefix.length).trim(); 
            }

            let latestDate = null;
            gruppe.bestaende.forEach(b => {
                if(b.created_at) {
                    const d = new Date(b.created_at);
                    if(!latestDate || d > latestDate) latestDate = d;
                }
            });
            
            let dateStr = "Unbekannt";
            if(latestDate) {
                dateStr = latestDate.toLocaleDateString('de-DE') + " " + latestDate.toLocaleTimeString('de-DE', {hour: '2-digit', minute:'2-digit'}) + " Uhr";
            }
            let isInfinite = gruppe.bestaende.some(b => Number(b.menge) === -1);
            let hatNachkaufMarkierung = gruppe.bestaende.some(b => Number(b.menge) === -3);
            let hatMinusBestand = gruppe.bestaende.some(b => Number(b.menge) === -2 || Number(b.menge) === -3);
            let resHtml = '';
            const resInfo = reservierungenDetails[artId];
            if (resInfo && resInfo.gesamt > 0 && !isInfinite) {
                let hoverText = "<strong>Reserviert für:</strong><br>";
                for (const [lName, lMenge] of Object.entries(resInfo.listen)) {
                    const safeLName = escapeHtml(lName);
                    hoverText += `• ${Number(lMenge) || 0}x in <i>${safeLName}</i><br>`;
                }
                resHtml = `<div class="no-select" style="font-size: 0.82em; color: #d35400; font-weight: normal; cursor: help; display: inline-flex; align-items: center; white-space: nowrap;"
                    data-hover-type="res" data-hover-content="${hoverText}"
                    onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)"
                    ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)">
                    📦 Reserviert: ${resInfo.gesamt}
                </div>`;
            }

            let bestandInfoHtml = "";
            const einheit = gruppe.artikel.einheit || 'Stück';
            const verfuegbarkeit = berechneArtikelVerfuegbarkeit(artId, gruppe.bestaende);
            const verfuegbarkeitFarbe = hatNachkaufMarkierung
                ? '#c0392b'
                : (hatMinusBestand ? '#27ae60' : (verfuegbarkeit === '∞' ? '#7f8c8d' : (Number(verfuegbarkeit) > 0 ? '#27ae60' : '#c0392b')));
            const verfuegbarkeitWert = hatNachkaufMarkierung
                ? 'Nachkaufen'
                : (hatMinusBestand ? 'Verfügbar' : (verfuegbarkeit === '∞' ? '∞' : `${verfuegbarkeit}`));
            const nachkaufHinweis = hatNachkaufMarkierung
                ? '<div style="margin-top: 4px; color: #c0392b; font-size: 0.8em; font-weight: bold;">Nachkaufen</div>'
                : (hatMinusBestand ? '<div style="margin-top: 4px; color: #27ae60; font-size: 0.8em; font-weight: bold;">Verfügbar</div>' : '');

            gruppe.bestaende.forEach(b => {
                const isInfLocal = (Number(b.menge) === -1);
                const isStrichLocal = (Number(b.menge) === -2);
                const isStrichNachkaufLocal = (Number(b.menge) === -3);
                let mengeZelle = "";
                
                if (isInfLocal) {
                    mengeZelle = `<span style="font-size: 1.2em; color: #7f8c8d; font-weight: bold;" title="Verbrauchsartikel (Unendlich)">∞</span> <small style="color: #888; font-size: 0.8em; margin-left: 3px;">${einheit}</small>`;
                } else if (isStrichLocal || isStrichNachkaufLocal) {
                    const strichStatus = isStrichNachkaufLocal ? 'warn' : 'ok';
                    const strichTitle = isStrichNachkaufLocal ? 'Nachkauf erforderlich' : 'Ausreichend vorhanden';
                    mengeZelle = `<span class="bestand-status-pill ${strichStatus}" title="${strichTitle}">-</span>`;
                } else {
                    const wertKlasse = Number(b.menge) > 0 ? 'bestand-menge-ok' : 'bestand-menge-low';
                    mengeZelle = `
                        <div style="display: flex; align-items: center; gap: 5px; justify-content: flex-end;">
                            <input type="text" id="menge-${b.id}" class="menge-input bestand-menge-input ${wertKlasse}" value="${b.menge}" onchange="speichereMenge(${b.id})" oninput="aktualisiereMengeEingabeFarbe(this)" style="width: 60px;">
                            <small style="color: #888; font-size: 0.8em; width: 45px; text-align: left;">${einheit}</small>
                        </div>`;
                }

                bestandInfoHtml += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid #f0f0f0; padding-bottom: 4px;">
                        <span style="font-size: 0.9em; color: #666;">📍 ${escapeHtml(b.lagerorte.name)}</span>
                        ${mengeZelle}
                    </div>`;
            });

            tr.innerHTML = `
                <td class="no-select" style="padding-left: ${indent}px; color:#333; vertical-align: top;"
                    data-hover-type="date" data-hover-content="${dateStr}"
                    onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)"
                    ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)">
                    ${iconLabel} <strong>${escapeHtml(displayName)}</strong>${wichtigBadge}${kommentarIcon}${kommentarAnzeige}
                </td>
                <td colspan="2" style="vertical-align: top;">
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        ${bestandInfoHtml}
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-top: 2px; font-size: 0.82em; line-height: 1.2; font-family: inherit;">
                            ${resHtml ? '<div>' + resHtml + '</div>' : ''}
                            <div style="min-width: 120px; display: flex; flex-direction: column; justify-content: flex-start; color: ${verfuegbarkeitFarbe}; white-space: nowrap; font-size: inherit; font-family: inherit; font-weight: normal; text-align: left;">
                                ${hatNachkaufMarkierung ? '' : (hatMinusBestand ? '' : `Verfügbar: <strong>${verfuegbarkeitWert}</strong>`)}
                                ${nachkaufHinweis}
                            </div>
                        </div>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    const hiddenArtikel = new Set(
        aktuelleDaten
            .filter(zeile => zeile.artikel && !zeile.artikel.wichtig)
            .map(zeile => zeile.artikel_id)
    );

    if (hiddenArtikel.size > 0 && aktiverRegalFilter === '') {
        const footerTr = document.createElement('tr');
        footerTr.innerHTML = `
            <td colspan="3" style="padding:14px; text-align:center; background:#f8fafc; border-top:1px solid #dfe6e9;">
                <button class="btn" onclick="toggleAlleArtikelSichtbarkeit()" style="background:#34495e; width:auto; min-width:220px;">
                    ${zeigeAlleArtikel ? 'Weniger anzeigen' : `Mehr anzeigen (${hiddenArtikel.size} weitere)`}
                </button>
            </td>
        `;
        tbody.appendChild(footerTr);
    }
}

function toggleAlleArtikelSichtbarkeit() {
    zeigeAlleArtikel = !zeigeAlleArtikel;
    wendeFilterAn();
}

function toggleEditMode() {
    isEditMode = !isEditMode;
    const b = document.getElementById('btn-edit-mode');
    if(b) { b.innerText = isEditMode ? "✏️ Bearbeiten: AN" : "✏️ Bearbeiten: AUS"; b.style.backgroundColor = isEditMode ? "#e67e22" : "#f39c12"; }
    document.querySelectorAll('.lager-edit-only').forEach(el => el.style.display = isEditMode ? '' : 'none');
    wendeFilterAn();
}

function addEditOrtRow(data = null) {
    const wrapper = document.getElementById('edit-orte-wrapper');
    const div = document.createElement('div');
    div.className = 'edit-ort-row';
    div.style = 'display: flex; gap: 8px; margin-bottom: 8px; align-items: center;';
    
    const defaultOrt = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
    
    let options = alleLagerorte.map(o => {
        let isSelected = false;
        if (data && data.lagerort_id == o.id) {
            isSelected = true;
        } 
        else if (!data && defaultOrt && o.id == defaultOrt.id) {
            isSelected = true;
        }
        return `<option value="${o.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(o.name)}</option>`;
    }).join('');
    
    let displayVal = '0';
    let hiddenOldVal = '0'; 
    let statusValue = 'zahl';
    
    if (data) {
        if (data.menge == -1) displayVal = '∞';
        else if (data.menge == -2) {
            displayVal = '-';
            statusValue = 'strich-ok';
        }
        else if (data.menge == -3) {
            displayVal = '-';
            statusValue = 'strich-warn';
        }
        else displayVal = data.menge;
        
        hiddenOldVal = data.alte_menge !== undefined && data.alte_menge !== null ? data.alte_menge : (data.menge < 0 ? '0' : data.menge);
    }

    div.innerHTML = `
        <div class="bestand-row-stack" style="width: 100%;">
            <select class="edit-ort-select" style="width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #ccc;">${options}</select>
            
            <div class="bestand-action-row" style="flex-wrap: nowrap; width: 100%;">
                <input type="text" class="edit-menge-input bestand-menge-input bestand-form-quantity" value="${displayVal}" data-old-value="${hiddenOldVal}" oninput="bestandEingabeGeaendert(this)" style="flex: 1.25; min-width: 0; padding: 12px 14px; border-radius: 6px; border: 1px solid #ccc; text-align: center; font-size: 1.08em; box-sizing: border-box;">
                <button type="button" class="btn bestand-mode-btn bestand-btn-inf" style="background: #95a5a6; padding: 10px 10px; width: auto; min-width: 68px; font-weight: bold;" title="Unendlich umschalten" onclick="toggleBestandInf(this)">∞</button>
                <button type="button" class="btn bestand-mode-btn bestand-btn-minus" style="background: #95a5a6; padding: 10px 10px; width: auto; min-width: 44px; font-weight: bold;" title="Ohne Bestand umschalten" onclick="toggleBestandMinus(this)">-</button>
            </div>

            <label class="bestand-nachkauf-wrap">
                <input type="checkbox" class="bestand-nachkauf-checkbox" onchange="toggleNachkaufCheckbox(this)">
                <span>Auf Nachkaufen setzen</span>
            </label>
        </div>

        <button type="button" class="btn" style="background:#e74c3c; padding: 8px 12px; width: auto; min-width: 40px;" onclick="removeEditRow(this)">🗑️</button>
    `;
    setzeBestandStatus(div, statusValue, statusValue === 'strich-warn');
    wrapper.appendChild(div);
}

function removeEditRow(btn) {
    const wrapper = document.getElementById('edit-orte-wrapper');
    if (wrapper.querySelectorAll('.edit-ort-row').length > 1) {
        btn.closest('.edit-ort-row').remove();
    } else {
        showToast("Ein Artikel muss mindestens einen Lagerort haben!", "warning");
    }
}

async function openEditModal(artikelId) {
    if (!isEditMode) return;
    const art = alleArtikelInfos.find(a => a.id === artikelId);
    const bestaende = aktuelleDaten.filter(b => b.artikel_id === artikelId);
    
    document.getElementById('edit-artikel-id').value = artikelId;
    document.getElementById('edit-name').value = art.name;
    document.getElementById('edit-kategorie').value = art.kategorie || '';
    document.getElementById('edit-einheit').value = art.einheit || 'Stück';
    const editWichtig = document.getElementById('edit-wichtig');
    if (editWichtig) editWichtig.checked = Boolean(art.wichtig);

    const wrapper = document.getElementById('edit-orte-wrapper');
    wrapper.innerHTML = '';
    
    bestaende.forEach(b => addEditOrtRow(b));
    if(bestaende.length === 0) addEditOrtRow();

    document.getElementById('editModal').style.display = 'block';
}

async function speichereBearbeitung() {
    try {
        const aid = document.getElementById('edit-artikel-id').value;
        const nName = document.getElementById('edit-name').value.trim();
        const nKat = document.getElementById('edit-kategorie').value.trim();
        const nEinheit = document.getElementById('edit-einheit').value;
        const nWichtig = Boolean(document.getElementById('edit-wichtig')?.checked);

        const doppelt = alleArtikelInfos.find(a => a.name.toLowerCase() === nName.toLowerCase() && String(a.id) !== String(aid));
        if (doppelt) {
            const weiter = confirm(`Hinweis: Ein anderer Artikel heißt bereits "${nName}" (Kategorie: ${doppelt.kategorie || 'Ohne'}). Wirklich umbenennen?`);
            if (!weiter) return;
        }

        await dbClient.from('artikel').update({ name: nName, kategorie: nKat, einheit: nEinheit, wichtig: nWichtig }).eq('id', aid);
        await dbClient.from('bestand').delete().eq('artikel_id', aid);

        const inserts = [];
        document.querySelectorAll('.edit-ort-row').forEach(row => {
            const oid = row.querySelector('.edit-ort-select').value;
            const input = row.querySelector('.edit-menge-input');
            
            const alteMengeAusFeld = werteMengeAus(input.getAttribute('data-old-value') || '0');
            const menge = leseBestandswertAusZeile(row);
            
            const finaleAlteMenge = (menge < 0) ? alteMengeAusFeld : menge;
            
            inserts.push({ artikel_id: aid, lagerort_id: oid, menge: menge, alte_menge: finaleAlteMenge });
        });

        if (inserts.length > 0) {
            await dbClient.from('bestand').insert(inserts);
        }

        closeModal('editModal');
        showToast("Artikel und Standorte aktualisiert!");
        ladeAlles();
    } catch(e) { showToast("Fehler beim Speichern", "error"); console.error(e); }
}

async function artikelLoeschen() {
    if(confirm("Diesen Artikel und alle seine Standorte wirklich komplett löschen?")) {
        const aId = document.getElementById('edit-artikel-id').value;
        await dbClient.from('bestand').delete().eq('artikel_id', aId);
        await dbClient.from('artikel').delete().eq('id', aId);
        closeModal('editModal'); 
        showToast('Artikel komplett gelöscht');
        ladeAlles();
    }
}

async function speichereMenge(bId) {
    const f = document.getElementById(`menge-${bId}`);
    if(!f) return;
    
    let neueMenge;
    if (f.value.trim() === '-') {
        neueMenge = -2;
    } else {
        neueMenge = werteMengeAus(f.value);
    }
    
    f.value = neueMenge === -2 ? '-' : neueMenge; 
    aktualisiereMengeEingabeFarbe(f);
    f.style.backgroundColor = '#fff3cd'; 

    const aktuellesDatum = new Date().toISOString();
    
    let { error } = await dbClient.from('bestand').update({ menge: neueMenge, alte_menge: neueMenge, created_at: aktuellesDatum }).eq('id', bId);
    if (error) {
        const fallback = await dbClient.from('bestand').update({ menge: neueMenge, alte_menge: neueMenge }).eq('id', bId);
        error = fallback.error;
    }
    
    if (!error) {
        f.style.backgroundColor = '#d4edda'; 
        showToast(`Bestand gespeichert: ${f.value}`);
        setTimeout(() => { if(f) f.style.backgroundColor = ''; ladeAlles(); }, 800); 
    } else { showToast("Speicherfehler!", "error"); }
}

async function artikelAnlegen() {
    try {
        const n = document.getElementById('new-name').value.trim();
        const k = document.getElementById('new-kategorie').value.trim();
        const e = document.getElementById('new-einheit').value;
        const w = Boolean(document.getElementById('new-wichtig')?.checked);
        
        if (!n) { showToast("Bitte einen Namen eingeben!", "warning"); return; }

        const existiertBereits = alleArtikelInfos.find(a => a.name.toLowerCase() === n.toLowerCase());
        if (existiertBereits) {
            const weiter = confirm(`Warnung: Ein Artikel mit dem Namen "${n}" existiert bereits in der Kategorie "${existiertBereits.kategorie || 'Ohne Kategorie'}". Möchtest du ihn trotzdem anlegen?`);
            if (!weiter) return;
        }

        const { data: nA, error: err } = await dbClient.from('artikel').insert([{ name: n, kategorie: k, einheit: e, wichtig: w }]).select();
        if (err) { showToast("Fehler: " + err.message, "error"); return; }
        
        const bestandInserts = [];
        const rows = document.querySelectorAll('#new-orte-wrapper .lagerort-row');
        
        rows.forEach(row => {
            const ortSelect = row.querySelector('.new-ort').value;
            const input = row.querySelector('.new-menge');
            
            const alteMengeAusFeld = werteMengeAus(input.getAttribute('data-old-value') || '0');
            const menge = leseBestandswertAusZeile(row);
            const finaleAlteMenge = (menge < 0) ? alteMengeAusFeld : menge;
            
            bestandInserts.push({ 
                artikel_id: nA[0].id, 
                lagerort_id: ortSelect, 
                menge: menge,
                alte_menge: finaleAlteMenge 
            });
        });
        
        await dbClient.from('bestand').insert(bestandInserts);
        
        closeModal('artikelModal'); 
        showToast('Neuer Artikel angelegt!');
        ladeAlles(); 
    } catch (e) { console.error(e); showToast("Fehler", "error"); }
}

function openNeuOrtModal() {
    document.getElementById('neu-ort-name').value = '';
    document.getElementById('neuOrtModal').style.display = 'block';
}

async function speichereNeuenOrt() {
    const nOrt = document.getElementById('neu-ort-name').value.trim();
    if (!nOrt) { 
        showToast("Bitte einen Namen für den Lagerort eingeben!", "warning"); 
        return; 
    }
    
    const { error } = await dbClient.from('lagerorte').insert([{ name: nOrt }]);
    
    if (error) {
        showToast("Fehler: " + error.message, "error"); 
    } else { 
        closeModal('neuOrtModal');
        showToast('Neuer Ort angelegt!'); 
        ladeAlles(); 
    }
}

function openOrteVerwalten() {
    const sel = document.getElementById('manage-ort-select');
    sel.innerHTML = '';
    
    if(alleLagerorte.length === 0) {
        showToast("Keine Lagerorte vorhanden.", "warning");
        return;
    }
    
    alleLagerorte.forEach(o => sel.add(new Option(o.name, o.id)));
    ortSelectChanged();
    document.getElementById('orteModal').style.display = 'block';
}

function ortSelectChanged() {
    const selId = document.getElementById('manage-ort-select').value;
    const ort = alleLagerorte.find(o => String(o.id) === String(selId));
    if(ort) {
        document.getElementById('manage-ort-name').value = ort.name;
    }
}

async function speichereOrt() {
    const oId = document.getElementById('manage-ort-select').value;
    const nName = document.getElementById('manage-ort-name').value.trim();
    if(!oId || !nName) return;

    const { error } = await dbClient.from('lagerorte').update({ name: nName }).eq('id', oId);
    if (error) showToast("Fehler: " + error.message, "error");
    else {
        closeModal('orteModal');
        showToast("Lagerort umbenannt!");
        ladeAlles();
    }
}

async function loescheOrt() {
    const oId = document.getElementById('manage-ort-select').value;
    if(!oId) return;

    const inUse = aktuelleDaten.some(b => String(b.lagerort_id) === String(oId));
    if(inUse) {
        showToast("Fehler: Ort ist nicht leer! Bitte erst die Artikel dort umbuchen.", "error");
        return;
    }

    if(confirm("Diesen Lagerort wirklich löschen?")) {
        const { error } = await dbClient.from('lagerorte').delete().eq('id', oId);
        if (error) showToast("Fehler: " + error.message, "error");
        else {
            closeModal('orteModal');
            showToast("Lagerort gelöscht!");
            ladeAlles();
        }
    }
}


async function ladeEventDaten() {
    try {
        const resList = await dbClient.from('packlisten').select('*').order('name');
        if(resList.error) throw resList.error;
        packlisten = resList.data || [];
        
        const sel = document.getElementById('packlisten-auswahl');
        const prevVal = sel.value;
        sel.innerHTML = '<option value="">-- Wähle Resort / Packliste --</option>';
        packlisten.forEach(pl => sel.add(new Option(pl.name, pl.id)));
        if (packlisten.some(pl => pl.id == prevVal)) sel.value = prevVal;

        const resPos = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie, einheit)');
        if(resPos.error) throw resPos.error;
        packlistenPositionen = resPos.data || [];

        zeigePackliste();
    } catch(e) {
        showToast("Fehler beim Event-Laden", "error");
    }
}

async function neuePacklisteAnlegen() {
    const nName = prompt("Name der neuen Packliste (z.B. Resort Wechselzone):");
    if (!nName || nName.trim() === "") return;
    const { error } = await dbClient.from('packlisten').insert([{ name: nName.trim() }]);
    if (error) showToast("Fehler: " + error.message, "error"); 
    else { showToast('Packliste erstellt'); ladeEventDaten(); }
}

function zeigePackliste() {
    const currentId = document.getElementById('packlisten-auswahl').value;
    const detailsDiv = document.getElementById('packliste-details');
    const tbody = document.getElementById('event-tabelle');
    tbody.innerHTML = '';

    if (!currentId) { detailsDiv.style.display = 'none'; return; }
    detailsDiv.style.display = 'block';

    const positionen = packlistenPositionen.filter(p => p.packliste_id == currentId);
    
    if (positionen.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Noch keine Gegenstände in dieser Liste.</td></tr>';
        return;
    }

    positionen.forEach(pos => {
        const tr = document.createElement('tr');
        let anzeigeName = "";
        let statusHtml = "";
        let availableHtml = "-";

        if (pos.artikel_id && pos.artikel) {
            anzeigeName = (pos.artikel.kategorie ? pos.artikel.kategorie + " > " : "") + pos.artikel.name;
            
            let gesamtLager = 0;
            let hatUnendlich = false;
            let hatStrich = false;
            
            aktuelleDaten.forEach(b => { 
                if(b.artikel_id === pos.artikel_id) {
                    if(Number(b.menge) === -1) hatUnendlich = true;
                    else if(Number(b.menge) === -2) hatStrich = true;
                    else if(Number(b.menge) >= 0) gesamtLager += Number(b.menge); 
                }
            });
            
            if (hatUnendlich || hatStrich) {
                availableHtml = hatUnendlich
                    ? `<span style="font-size:1.2em; font-weight:bold;">∞</span>`
                    : `<span style="font-size:1.2em; font-weight:bold;">-</span>`;
                statusHtml = `<span class="event-ok">✅ OK</span>`;
            } else {
                let verbrauchtAndere = 0;
                packlistenPositionen.forEach(p => {
                    if (p.artikel_id === pos.artikel_id && p.packliste_id != currentId) verbrauchtAndere += Number(p.menge);
                });

                const verfuegbar = gesamtLager - verbrauchtAndere;
                availableHtml = verfuegbar;

                if (pos.menge > verfuegbar) {
                    statusHtml = `<span class="event-warning">❌ Zu wenig (${verfuegbar - pos.menge})</span>`;
                } else {
                    statusHtml = `<span class="event-ok">✅ OK</span>`;
                }
            }
        } else {
            anzeigeName = escapeHtml(pos.eigener_name) + " <small style='color:#999;'>(Eigener Posten)</small>";
            statusHtml = `<span style="color:#7f8c8d;">- Manuell prüfen -</span>`;
        }

        let mengeZelle = pos.menge;
        if (isEventEditMode) {
            mengeZelle = `<input type="text" class="menge-input" value="${pos.menge}" onchange="updatePackMenge(${pos.id}, this.value)">`;
            statusHtml += ` <button class="btn" style="background:#e74c3c; padding:4px 8px; font-size:0.8em; margin-left:10px;" onclick="loeschePackPosition(${pos.id})">🗑️</button>`;
        }

        tr.innerHTML = `<td><strong>${anzeigeName}</strong></td><td>${mengeZelle}</td><td>${availableHtml}</td><td>${statusHtml}</td>`;
        tbody.appendChild(tr);
    });
}

function toggleEventEditMode() {
    isEventEditMode = !isEventEditMode;
    const b = document.getElementById('btn-event-edit');
    if(b) { b.innerText = isEventEditMode ? "✏️ Bearbeiten: AN" : "✏️ Bearbeiten: AUS"; b.style.backgroundColor = isEventEditMode ? "#e67e22" : "#f39c12"; }
    document.querySelectorAll('.event-edit-only').forEach(el => el.style.display = isEventEditMode ? '' : 'none');
    zeigePackliste();
}

function openPackItemModal() {
    const listId = document.getElementById('packlisten-auswahl').value;
    if (!listId) { showToast("Bitte wähle zuerst eine Packliste aus!", "warning"); return; }
    
    const datalist = document.getElementById('pack-artikel-datalist');
    datalist.innerHTML = '';
    document.getElementById('pack-artikel-input').value = '';
    
    const sortierteArt = [...alleArtikelInfos].sort((a, b) => {
        const aKat = a.kategorie || '';
        const bKat = b.kategorie || '';
        if (aKat !== bKat) return aKat.localeCompare(bKat, 'de');
        return a.name.localeCompare(b.name, 'de');
    });

    sortierteArt.forEach(art => {
        const nameString = (art.kategorie ? art.kategorie + " > " : "") + art.name;
        const option = document.createElement('option');
        option.value = nameString;
        datalist.appendChild(option);
    });
    
    document.getElementById('packItemModal').style.display = 'block';
    togglePackTyp();
}

function togglePackTyp() {
    const typ = document.getElementById('pack-typ').value;
    document.getElementById('div-pack-lager').style.display = typ === 'lager' ? 'block' : 'none';
    document.getElementById('div-pack-custom').style.display = typ === 'custom' ? 'block' : 'none';
    aktualisierePackVerfuegbarkeit(); 
}

function aktualisierePackVerfuegbarkeit() {
    const typ = document.getElementById('pack-typ').value;
    const infoDiv = document.getElementById('pack-artikel-info');

    if (typ !== 'lager') { infoDiv.innerHTML = ''; return; }

    const inputVal = document.getElementById('pack-artikel-input').value;
    const matchedArt = alleArtikelInfos.find(a => {
        const n = (a.kategorie ? a.kategorie + " > " : "") + a.name;
        return n === inputVal;
    });

    if (!matchedArt) { infoDiv.innerHTML = ''; return; }
    const selId = matchedArt.id;

    let gesamtLager = 0;
    let hatUnendlich = false;
    let hatStrich = false;
    aktuelleDaten.forEach(b => { 
        if(b.artikel_id === selId) {
            if(Number(b.menge) === -1) hatUnendlich = true;
            else if(Number(b.menge) === -2) hatStrich = true;
            else if(Number(b.menge) >= 0) gesamtLager += Number(b.menge); 
        }
    });

    if (hatUnendlich || hatStrich) {
        infoDiv.innerHTML = hatUnendlich
            ? `✅ Sonderartikel (Bestand wird nicht limitiert: ∞)`
            : `✅ Sonderartikel (Bestand wird nicht limitiert: -)`;
        infoDiv.style.color = '#27ae60';
        return;
    }

    let reserviert = 0;
    packlistenPositionen.forEach(p => { if (p.artikel_id === selId) reserviert += Number(p.menge); });

    const verfuegbar = gesamtLager - reserviert;

    if (verfuegbar > 0) {
        infoDiv.innerHTML = `✅ Noch <strong>${verfuegbar}</strong> frei im Lager`;
        infoDiv.style.color = '#27ae60'; 
    } else if (verfuegbar === 0) {
        infoDiv.innerHTML = `⚠️ Nichts mehr frei (Genau 0)`;
        infoDiv.style.color = '#f39c12'; 
    } else {
        infoDiv.innerHTML = `❌ Überbucht! (Es fehlen ${Math.abs(verfuegbar)})`;
        infoDiv.style.color = '#e74c3c'; 
    }
}

async function packPositionSpeichern() {
    const listId = document.getElementById('packlisten-auswahl').value;
    const typ = document.getElementById('pack-typ').value;
    const menge = werteMengeAus(document.getElementById('pack-menge').value); 
    
    let dbObj = { packliste_id: listId, menge: menge };

    if (typ === 'lager') {
        const inputVal = document.getElementById('pack-artikel-input').value;
        
        const matchedArt = alleArtikelInfos.find(a => {
            const n = (a.kategorie ? a.kategorie + " > " : "") + a.name;
            return n === inputVal;
        });
        
        if (!matchedArt) { 
            showToast("Bitte wähle einen gültigen Artikel aus der Vorschlagsliste!", "warning"); 
            return; 
        }
        dbObj.artikel_id = matchedArt.id;
    } else {
        const en = document.getElementById('pack-eigener-name').value;
        if (!en) { showToast("Bitte Namen eingeben!", "warning"); return; }
        dbObj.eigener_name = en;
    }

    const { error } = await dbClient.from('packlisten_positionen').insert([dbObj]);
    if (error) showToast("Fehler: " + error.message, "error");
    else { 
        closeModal('packItemModal'); 
        document.getElementById('pack-eigener-name').value=''; 
        showToast("Zur Packliste hinzugefügt!");
        ladeAlles(); 
    }
}

async function updatePackMenge(posId, neueMenge) {
    const calcMenge = werteMengeAus(neueMenge);
    await dbClient.from('packlisten_positionen').update({ menge: calcMenge }).eq('id', posId);
    showToast("Menge in Packliste aktualisiert");
    ladeAlles();
}

async function loeschePackPosition(posId) {
    if(confirm("Position von der Liste löschen?")) {
        await dbClient.from('packlisten_positionen').delete().eq('id', posId);
        ladeAlles();
    }
}

async function umbenennePackliste() {
    const listId = document.getElementById('packlisten-auswahl').value;
    if (!listId) { showToast("Bitte wähle zuerst eine Packliste aus.", "warning"); return; }

    const aktuelleListe = packlisten.find(pl => pl.id == listId);
    const neuerName = prompt("Neuer Name für die Packliste:", aktuelleListe.name);

    if (!neuerName || neuerName.trim() === "" || neuerName === aktuelleListe.name) return;
    const { error } = await dbClient.from('packlisten').update({ name: neuerName.trim() }).eq('id', listId);
    if (error) showToast("Fehler: " + error.message, "error"); 
    else { showToast("Packliste umbenannt"); ladeEventDaten(); }
}

async function loeschePackliste() {
    const listId = document.getElementById('packlisten-auswahl').value;
    if (!listId) return;

    const aktuelleListe = packlisten.find(pl => pl.id == listId);
    if (confirm(`Möchtest du die Packliste "${aktuelleListe.name}" wirklich löschen?`)) {
        const { error } = await dbClient.from('packlisten').delete().eq('id', listId);
        if (error) showToast("Fehler: " + error.message, "error"); 
        else { document.getElementById('packlisten-auswahl').value = ""; showToast("Gelöscht!"); ladeAlles(); }
    }
}

function startEinkaufsliste() {
    einkaufslisteArray = [];
    autoFehlbestandListe = [];
    eigeneVorschlaegeListe = [];
    manuelleEintraegeListe = [];

    let artikelBestand = {};
    let nachkaufMarkierteArtikel = new Set();
    
    aktuelleDaten.forEach(b => {
        const menge = Number(b.menge);
        if (menge === -3) {
            nachkaufMarkierteArtikel.add(String(b.artikel_id));
        } else if (menge === -1 || menge === -2) {
            // unbelegte Werte tauchen nicht im verfügbaren Lagerbestand auf
        } else if (Number(b.menge) >= 0) {
            artikelBestand[b.artikel_id] = (artikelBestand[b.artikel_id] || 0) + Number(b.menge);
        }
    });

    let artikelBedarf = {};
    let eigeneGegenstaende = {}; 

    packlistenPositionen.forEach(p => {
        if (p.artikel_id) {
            if (!artikelIgnorieren.has(p.artikel_id)) {
                artikelBedarf[p.artikel_id] = (artikelBedarf[p.artikel_id] || 0) + Number(p.menge);
            }
        } else if (p.eigener_name) {
            eigeneGegenstaende[p.eigener_name] = (eigeneGegenstaende[p.eigener_name] || 0) + Number(p.menge);
        }
    });

    const ulAuto = document.getElementById('auto-kauf-liste');
    const ulEigene = document.getElementById('eigene-kauf-liste');
    ulAuto.innerHTML = '';
    if (ulEigene) ulEigene.innerHTML = '';

    function fuegeAutoFehlbestandHinzu(artikel, menge, grund) {
        const bestehenderEintrag = autoFehlbestandListe.find(item => item.artikel === artikel);
        if (bestehenderEintrag) {
            bestehenderEintrag.menge += menge;
            if (grund && !String(bestehenderEintrag.grund || '').includes(grund)) {
                bestehenderEintrag.grund = `${bestehenderEintrag.grund} / ${grund}`;
            }
        } else {
            autoFehlbestandListe.push({ artikel: artikel, menge: menge, grund: grund });
        }
    }

    alleArtikelInfos.forEach(art => {
        let bestand = nachkaufMarkierteArtikel.has(String(art.id)) ? 0 : (artikelBestand[art.id] || 0);
        let bedarf = artikelBedarf[art.id] || 0;

        if (nachkaufMarkierteArtikel.has(String(art.id))) {
            const fehlMenge = Math.max(1, bedarf);
            fuegeAutoFehlbestandHinzu(art.name, fehlMenge, bedarf > 0 ? 'Nachkauf markiert' : 'Nachkauf markiert');
        } else if (bedarf > bestand) {
            let fehlMenge = bedarf - bestand;
            fuegeAutoFehlbestandHinzu(art.name, fehlMenge, 'Fehlt im Lager');
        }
    });

    if (ulAuto) {
        if (autoFehlbestandListe.length === 0) {
            ulAuto.innerHTML = '<li style="color:#27ae60;">Alles grün! Das Lager deckt alle Listen ab.</li>';
        } else {
            ulAuto.innerHTML = autoFehlbestandListe.map(item => `<li>${item.menge}x ${escapeHtml(item.artikel)}</li>`).join('');
        }
    }

    for (let name in eigeneGegenstaende) {
        eigeneVorschlaegeListe.push({ artikel: name, menge: eigeneGegenstaende[name], grund: 'Sonderposten Packliste' });
    }

    if (ulEigene) {
        if (eigeneVorschlaegeListe.length === 0) {
            ulEigene.innerHTML = '<li style="color:#7f8c8d;">Keine eigenen Gegenstände gefunden.</li>';
        } else {
            eigeneVorschlaegeListe.forEach((item, index) => {
                ulEigene.innerHTML += `
                    <li style="margin-bottom: 6px;">
                        <label style="display:flex; gap:8px; align-items:center; cursor:pointer;">
                            <input type="checkbox" class="eigene-kauf-check" data-index="${index}" checked onchange="aktualisiereEinkaufslisteAuswahl()">
                            <span>${item.menge}x ${escapeHtml(item.artikel)}</span>
                        </label>
                    </li>`;
            });
        }
    }

    aktualisiereEinkaufslisteAuswahl();

    document.getElementById('manuell-kauf-liste').innerHTML = '';
    document.getElementById('kauflisteModal').style.display = 'block';
}

function aktualisiereEinkaufslisteAuswahl() {
    const checks = document.querySelectorAll('.eigene-kauf-check');
    const ausgewaehlteEigene = [];

    checks.forEach(chk => {
        if (!chk.checked) return;
        const idx = Number(chk.getAttribute('data-index'));
        const item = eigeneVorschlaegeListe[idx];
        if (item) ausgewaehlteEigene.push(item);
    });

    einkaufslisteArray = [...autoFehlbestandListe, ...ausgewaehlteEigene, ...manuelleEintraegeListe];
}

function manuellAufZettel() {
    const nameFeld = document.getElementById('manuell-kauf-name');
    const mengeFeld = document.getElementById('manuell-kauf-menge');
    const name = nameFeld.value.trim();
    const menge = werteMengeAus(mengeFeld.value); 

    if (!name || menge <= 0) return;

    manuelleEintraegeListe.push({ artikel: name, menge: menge, grund: 'Manuell hinzugefügt' });
    aktualisiereEinkaufslisteAuswahl();
    
    const ulManuell = document.getElementById('manuell-kauf-liste');
    ulManuell.innerHTML += `<li>${menge}x ${escapeHtml(name)}</li>`;

    nameFeld.value = '';
    mengeFeld.value = '1';
    nameFeld.focus();
}

async function downloadExcel() {
    if (einkaufslisteArray.length === 0) {
        showToast("Die Liste ist komplett leer.", "warning");
        return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Einkaufsliste');

    sheet.mergeCells('A1:C1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = '📦 EINKAUFSLISTE - TRISPORT ERDING';
    titleCell.font = { size: 16, bold: true, color: { argb: 'FFE3000F' } }; 
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    sheet.mergeCells('A2:C2');
    const timeCell = sheet.getCell('A2');
    timeCell.value = 'Erstellt am: ' + new Date().toLocaleString('de-DE');
    timeCell.font = { italic: true, color: { argb: 'FF666666' } }; 
    timeCell.alignment = { horizontal: 'center' };

    const headerRow = sheet.getRow(4);
    headerRow.values = ['ARTIKEL / MATERIAL', 'MENGE', 'GRUND / HERKUNFT'];
    
    ['A', 'B', 'C'].forEach(col => {
        const cell = sheet.getCell(`${col}4`);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; 
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' } 
        };
        cell.border = { bottom: { style: 'medium', color: { argb: 'FF000000' } } };
    });

    let currentRow = 5;
    einkaufslisteArray.forEach(item => {
        const row = sheet.getRow(currentRow);
        row.values = [item.artikel, item.menge, item.grund];
        
        ['A', 'B', 'C'].forEach(col => {
            sheet.getCell(`${col}${currentRow}`).border = {
                bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } }
            };
        });
        currentRow++;
    });

    sheet.getColumn(1).width = 40; 
    sheet.getColumn(2).width = 12; 
    sheet.getColumn(3).width = 30; 

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Trisport_Einkauf_${new Date().toISOString().split('T')[0]}.xlsx`;
    anchor.click();
    window.URL.revokeObjectURL(url);

    closeModal('kauflisteModal');
    showToast("Download gestartet!");
}

function druckePackliste() {
    const listId = document.getElementById('packlisten-auswahl').value;
    if (!listId) return;

    const liste = packlisten.find(pl => pl.id == listId);
    const positionen = packlistenPositionen.filter(p => p.packliste_id == listId);

    const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf("/") + 1);

    const printWindow = window.open('', '_blank');

    const gruppen = {};

    positionen.forEach(pos => {
        let kategorie = 'Ohne Kategorie';
        let name = '';
        let ort = '-';

        if (pos.artikel_id && pos.artikel) {
            kategorie = (pos.artikel.kategorie || 'Ohne Kategorie').trim() || 'Ohne Kategorie';
            name = pos.artikel.name;

            const ortNamen = aktuelleDaten
                .filter(b => b.artikel_id === pos.artikel_id && b.lagerorte && b.lagerorte.name)
                .map(b => b.lagerorte.name);

            const eindeutigeOrte = Array.from(new Set(ortNamen));
            ort = eindeutigeOrte.length > 0 ? eindeutigeOrte.join(', ') : '-';
        } else {
            kategorie = 'Eigene Gegenstaende';
            name = (pos.eigener_name || 'Unbenannt') + ' (Manuell)';
            ort = 'Nicht im Lager';
        }

        if (!gruppen[kategorie]) gruppen[kategorie] = [];
        gruppen[kategorie].push({ name, menge: pos.menge, ort });
    });

    const kategorienSortiert = Object.keys(gruppen).sort((a, b) => {
        if (a === 'Ohne Kategorie') return 1;
        if (b === 'Ohne Kategorie') return -1;
        if (a === 'Eigene Gegenstaende') return 1;
        if (b === 'Eigene Gegenstaende') return -1;
        return a.localeCompare(b, 'de');
    });

    let rowsHtml = '';
    kategorienSortiert.forEach(kategorie => {
        rowsHtml += `
            <tr class="category-row">
                <td colspan="4">📁 ${kategorie}</td>
            </tr>`;

        gruppen[kategorie]
            .sort((a, b) => a.name.localeCompare(b.name, 'de'))
            .forEach(item => {
                rowsHtml += `
                    <tr>
                        <td style="text-align:center; width: 60px;"><div class="check"></div></td>
                        <td><strong>${item.name}</strong></td>
                        <td style="width: 80px;">${item.menge}</td>
                        <td>${item.ort}</td>
                    </tr>`;
            });
    });

    if (!rowsHtml) {
        rowsHtml = '<tr><td colspan="4" style="text-align:center; color:#666;">Keine Positionen in dieser Packliste.</td></tr>';
    }
    
    let html = `
        <html>
        <head>
            <title>Packliste: ${liste.name}</title>
            <style>
                body { font-family: sans-serif; margin: 0; padding: 16px; color: #333; }
                .header-container { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e3000f; padding-bottom: 15px; margin-bottom: 16px; }
                .header-text h1 { color: #e3000f; margin: 0 0 5px 0; }
                .header-text p { margin: 0; color: #666; }
                .corner-logo { height: 60px; width: auto; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; table-layout: fixed; }
                thead { display: table-header-group; }
                th, td { border: 1px solid #ddd; padding: 10px; text-align: left; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                th:nth-child(1), td:nth-child(1) { width: 60px; text-align: center; }
                th:nth-child(2), td:nth-child(2) { width: 44%; }
                th:nth-child(3), td:nth-child(3) { width: 80px; }
                th:nth-child(4), td:nth-child(4) { width: 36%; }
                th { background-color: #f2f2f2; }
                .category-row td { background:#eef3f8; font-weight:bold; color:#2c3e50; }
                .check { width: 30px; border: 1px solid #333; height: 20px; display: inline-block; }
                @media print {
                    @page { size: A4 portrait; margin: 10mm; }
                    .no-print { display: none; }
                    tr { page-break-inside: avoid; }
                    .category-row { page-break-after: avoid; }
                    .category-row + tr { page-break-before: avoid; }
                    body { padding: 0; }
                }
            </style>
        </head>
        <body>
            <button class="no-print" onclick="window.print()" style="margin-bottom:20px; padding:10px; cursor: pointer;">🖨️ Jetzt drucken</button>
            <div class="header-container">
                <div class="header-text">
                    <h1>📦 Packliste: ${liste.name}</h1>
                    <p>Erstellt am: ${new Date().toLocaleDateString('de-DE')}</p>
                </div>
                <img src="${baseUrl}trisportlogo.jpg" class="corner-logo" alt="Trisport Erding Logo">
            </div>
            <table>
                <thead>
                    <tr><th>Gepackt</th><th>Gegenstand / Material</th><th>Menge</th><th>Lagerort</th></tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
            <div style="margin-top: 30px; font-size: 0.8em; color: #666; text-align: center;">Trisport Erding Lager-Verwaltung</div>
        </body>
        </html>`;

    printWindow.document.write(html);
    printWindow.document.close();
}
// --- KOMMENTAR FUNKTIONEN ---

function openKommentarModal(artikelId, event) {
    // Verhindert, dass der Klick auf die Sprechblase versehentlich 
    // den Artikel-Bearbeiten-Modus öffnet
    if (event) event.stopPropagation(); 
    if (!isEditMode) return;
    
    // Artikel suchen
    const art = alleArtikelInfos.find(a => String(a.id) === String(artikelId));
    if (!art) return;
    
    document.getElementById('kommentar-artikel-id').value = artikelId;
    document.getElementById('kommentar-artikel-name').innerText = art.name;
    document.getElementById('kommentar-text').value = art.kommentar || '';
    
    document.getElementById('kommentarModal').style.display = 'block';
}

async function speichereKommentar() {
    const artId = document.getElementById('kommentar-artikel-id').value;
    const neuerKommentar = document.getElementById('kommentar-text').value;
    
    // In Supabase speichern
    const { error } = await dbClient.from('artikel')
        .update({ kommentar: neuerKommentar })
        .eq('id', artId);
        
    if (error) {
        showToast("Fehler beim Speichern des Kommentars: " + error.message, "error");
    } else {
        closeModal('kommentarModal');
        showToast("Kommentar gespeichert!");
        ladeAlles(); // Lädt die Tabelle neu, damit sich die Farbe der Sprechblase aktualisiert
    }
}

async function formularAntwortSpeichern() {
    const formname = document.getElementById('formular-name')?.value.trim() || 'Anonyme Person';
    const frage1 = document.getElementById('formular-frage1')?.value.trim() || '';
    const frage2 = document.getElementById('formular-frage2')?.value.trim() || '';

    if (!frage1 && !frage2) {
        showToast('Bitte beantworte mindestens eine Frage.', 'warning');
        return;
    }

    const { error } = await dbClient.from(FORMULAR_TABLE).insert([
        { name: formname, frage1, frage2 }
    ]);

    if (error) {
        console.error(error);
        showToast('Speichern fehlgeschlagen. Tabelle "formular_antworten" prüfen.', 'error');
        return;
    }

    showToast('Antwort gespeichert. Danke!');
    const nameFeld = document.getElementById('formular-name');
    const q1 = document.getElementById('formular-frage1');
    const q2 = document.getElementById('formular-frage2');
    if (nameFeld) nameFeld.value = '';
    if (q1) q1.value = '';
    if (q2) q2.value = '';
}

async function formularAntwortenLaden() {
    const ziel = document.getElementById('formular-antworten');
    if (!ziel) return;

    const { data, error } = await dbClient
        .from(FORMULAR_TABLE)
        .select('name, frage1, frage2, created_at')
        .order('created_at', { ascending: false })
        .limit(200);

    if (error) {
        console.error(error);
        ziel.style.display = 'block';
        ziel.innerHTML = '<p style="color:#c0392b; margin:0;">Antworten konnten nicht geladen werden. Bitte Supabase-Tabelle "formular_antworten" inkl. Spalten "frage1", "frage2", "name", "created_at" prüfen.</p>';
        return;
    }

    if (!data || data.length === 0) {
        ziel.style.display = 'block';
        ziel.innerHTML = '<p style="margin:0; color:#7f8c8d;">Noch keine Antworten vorhanden.</p>';
        return;
    }

    let html = '';
    data.forEach((eintrag, index) => {
        const zeit = eintrag.created_at
            ? new Date(eintrag.created_at).toLocaleString('de-DE')
            : 'Unbekannt';

        html += `
            <div class="survey-answer-item">
                <h4>Antwort ${index + 1} - ${escapeHtml(zeit)}</h4>
                <p><strong>Name:</strong><br>${escapeHtml(eintrag.name) || '<em>-</em>'}</p>
                <p><strong>Frage 1:</strong><br>${escapeHtml(eintrag.frage1) || '<em>-</em>'}</p>
                <p><strong>Frage 2:</strong><br>${escapeHtml(eintrag.frage2) || '<em>-</em>'}</p>
            </div>
        `;
    });

    ziel.style.display = 'block';
    ziel.innerHTML = html;
}
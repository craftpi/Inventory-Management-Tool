// =========================================================================
// 1. KONFIGURATION & GLOBALE ZUSTÄNDE
// =========================================================================
const SUPABASE_URL = 'https://trilager-api.pius-s.de';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InRyaWxhZ2VyIiwiaWF0IjoxNzg1ODA3MzI1LCJleHAiOjIxMDExNjczMjV9.COsEZ-KOGycjE2S1eALGohmmjosW8CZs038jezg6lSU';

const STORAGE_KEYS = {
    SESSION: 'trilager_local_session_v2',
    ATTEMPTS: 'trilager_login_attempts_v1',
    LOCK: 'trilager_login_lock_until_v1'
};

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
let aktiverRegalFilter = '';
let finderFilterModus = 'fehlend'; // 'fehlend' oder 'alle'

// Kisten- & Scan-Zustände
let kistenCheckAktuelleId = '';
let aktiverQrScanner = null;
let aktiverNfcModus = null;
let nfcAbortController = null;
let scanSperre = { kisten: false, rueckgabe: false };

// =========================================================================
// 2. HILFSFUNKTIONEN & TOAST
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

function extrahiereRegalName(text) {
    const raw = String(text || '').trim();
    const m = raw.match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : raw;
}

// =========================================================================
// 3. AUTH & SESSION
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
        ladeAlles();
    }
}

function handleLogout() {
    window.localStorage.removeItem(STORAGE_KEYS.SESSION);
    setzeAuthToken(null);
    $('login-overlay').style.display = 'flex';
}

// =========================================================================
// 4. DATEN LADEN (BESTAND, LAGERORTE)
// =========================================================================
async function ladeAlles() {
    await ladeLagerorte();
    await ladeBestand();
    wendeFilterAn();
    if (aktuellerModus === 'event') await ladeEventDaten();
    if (aktuellerModus === 'kisten') renderKistenListe();
}

async function ladeLagerorte() {
    const { data } = await dbClient.from('lagerorte').select('*').order('name');
    alleLagerorte = data || [];

    const selectsNeu = document.querySelectorAll('.new-ort');
    const selectEdit = $('edit-ort');
    selectsNeu.forEach(sel => populateSelect(sel, alleLagerorte));
    if (selectEdit) populateSelect(selectEdit, alleLagerorte);
}

async function ladeBestand() {
    const { data: alleArt } = await dbClient.from('artikel').select('*').order('name');
    alleArtikelInfos = alleArt || [];

    // Bestand mit Soll-Werten laden (alte_menge dient als Referenz/Soll-Bestand)
    let { data } = await dbClient.from('bestand').select(`
        id, menge, alte_menge, created_at, artikel_id, lagerort_id, 
        artikel (id, name, kategorie, einheit, kommentar, wichtig), 
        lagerorte (id, name, nfc_code)
    `).order('id');

    aktuelleDaten = (data || []).map(z => ({
        ...z,
        // Soll-Menge ermitteln: Falls alte_menge existiert und positiv ist, sonst menge
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
        Array.from(regale).sort().forEach(r => comboDropdown.add(new Option('🏷️ Regal: ' + r, 'regal:' + r)));
    }
    if (datalist) datalist.innerHTML = Array.from(kategorien).sort().map(k => `<option value="${escapeHtml(k)}">`).join('');
    if (artikelDatalist) artikelDatalist.innerHTML = alleArtikelInfos.map(a => `<option value="${escapeHtml(a.name)}">`).join('');
}

// =========================================================================
// 5. DAS VEREINHEITLICHTE KISTEN-SYSTEM (ENTNEHMEN & ZURÜCKBUCHEN)
// =========================================================================

function gibKistenBestand(lid) {
    return aktuelleDaten.filter(z => String(z.lagerort_id) === String(lid))
        .sort((a, b) => (a.artikel?.name || '').localeCompare(b.artikel?.name || '', 'de'));
}

// Öffnet das Kisten-Modal (wird bei Scan oder Klick aufgerufen)
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
        const istSonder = ist < 0; // -1 (unendlich) oder -2/-3

        const card = document.createElement('div');
        card.className = `kiste-item-card ${fehlt > 0 ? 'fehlend' : ''}`;

        let statusText = '';
        if (ist === -1) statusText = 'Bestand: ∞ (Unbegrenzt)';
        else if (ist === -2) statusText = 'Status: Ausreichend';
        else if (ist === -3) statusText = 'Status: 🔴 Nachkaufen';
        else {
            statusText = `Ist: <strong>${ist}</strong> / Soll: <strong>${soll}</strong>`;
            if (fehlt > 0) statusText += ` <span style="color:#c0392b; font-weight:bold;">(${fehlt} fehlen)</span>`;
            else statusText += ` <span style="color:#27ae60;">✅ Voll</span>`;
        }

        card.innerHTML = `
            <div style="flex:1;">
                <div style="font-weight:bold; font-size:1.02em; color:#2c3e50;">${escapeHtml(z.artikel?.name || 'Unbekannt')}</div>
                <div style="font-size:0.85em; color:#555; margin-top:2px;">${statusText}</div>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
                ${!istSonder ? `
                    <button class="stepper-btn" onclick="aendereArtikelMengeInKiste(${z.id}, -1)" title="1 Stück entnehmen">−</button>
                    <span style="font-weight:bold; min-width:30px; text-align:center; font-size:1.1em;">${ist}</span>
                    <button class="stepper-btn" onclick="aendereArtikelMengeInKiste(${z.id}, 1)" title="1 Stück zurückbuchen" style="background:#27ae60; color:#fff;">+</button>
                ` : `
                    <span style="font-weight:bold; color:#7f8c8d; padding:0 8px;">${ist === -1 ? '∞' : '-'}</span>
                `}
                <button class="btn" style="background:#e74c3c; padding:6px 10px; width:auto; min-height:36px; margin-left:6px;" onclick="entferneArtikelAusKiste(${z.id})" title="Aus dieser Kiste entfernen">🗑️</button>
            </div>
        `;
        wrapper.appendChild(card);
    });
}

// 1. Ganze Kiste entnehmen -> Setzt alle zählbaren Artikel auf 0 (ausgebucht)
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
    showToast('📤 Kiste als entnommen ausgebucht!');
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

// 2. Ganze Kiste zurückbuchen -> Setzt alle Artikel wieder auf ihren Soll-Wert
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

// 3. Einzelnen Artikel in Kiste anpassen (+1 / -1)
async function aendereArtikelMengeInKiste(bestandId, delta) {
    const eintrag = aktuelleDaten.find(b => b.id === bestandId);
    if (!eintrag) return;
    const aktuell = Number(eintrag.menge);
    if (aktuell < 0) return; // Unbegrenzt nicht ändern

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

    // Prüfen, ob Artikel bereits an diesem Ort liegt
    const existiert = aktuelleDaten.some(b => b.artikel_id === art.id && String(b.lagerort_id) === String(kistenCheckAktuelleId));
    if (existiert) return showToast('Dieser Artikel liegt bereits in dieser Kiste.', 'warning');

    const startMenge = prompt(`Soll-Menge für "${art.name}" in dieser Kiste:`, '1');
    if (startMenge === null) return;
    const mengeNum = Math.max(0, parseInt(startMenge, 10) || 1);

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
    showToast('Artikel aus Kiste entfernt.');
    await ladeAlles();
    renderKistenInhaltListe(kistenCheckAktuelleId);
}

function schliesseKistenCheckModal() {
    closeModal('kistenCheckModal');
    kistenCheckAktuelleId = '';
}

// =========================================================================
// 6. DER ARTIKEL-FINDER: „WO GEHÖRT DAS HIN? / RÜCKGABE OHNE CODE“
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

        return `
            <div style="border:1px solid #d9e3ec; background:#fff; border-radius:8px; padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
                <div style="flex:1;">
                    <div style="font-size:1.05em; font-weight:bold; color:#2c3e50;">${escapeHtml(z.artikel?.name)}</div>
                    <div style="color:#16a085; font-weight:bold; margin-top:2px;">
                        📍 Gehört in: <u>${escapeHtml(z.lagerorte?.name || 'Unbekannter Ort')}</u>
                    </div>
                    <small style="color:#666;">
                        ${soll > 0 ? `Vorhanden: ${ist} / ${soll} ${fehlt > 0 ? `<span style="color:#c0392b; font-weight:bold;">(fehlen: ${fehlt})</span>` : '✅'}` : 'Nicht limitiert'}
                    </small>
                </div>
                <div style="display:flex; gap:6px;">
                    <button class="btn" style="background:#27ae60; padding:8px 12px; width:auto; min-height:40px;" onclick="buchtArtikelZurueckInKiste(${z.id})">
                        📥 Hier rein (+1)
                    </button>
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
    showToast(`✅ 1x "${eintrag.artikel?.name}" in "${eintrag.lagerorte?.name}" zurückgebucht!`);
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

// Universeller Scan-Decoder (Kiste oder Artikel)
async function verarbeiteUniversalScan(rawCode) {
    if (scanSperre.kisten) return;
    scanSperre.kisten = true;
    setTimeout(() => scanSperre.kisten = false, 1500);

    const raw = String(rawCode || '').trim();

    // 1. Prüfen, ob es ein Kistencheck / Lagerort ist
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

    // 2. Prüfen, ob es ein Einzelartikel-QR ist (?rueckgabe=123 oder artikel:123)
    let artikelId = null;
    const mArtUrl = /rueckgabe=([^&\s]+)/i.exec(raw);
    const mArtPref = /^artikel:(.+)$/i.exec(raw);
    if (mArtUrl) artikelId = mArtUrl[1].trim();
    else if (mArtPref) artikelId = mArtPref[1].trim();

    if (artikelId) {
        schliesseKistenKameraModal();
        const bestandsEintraege = aktuelleDaten.filter(b => String(b.artikel_id) === String(artikelId));
        if (bestandsEintraege.length === 1) {
            // Eindeutiger Ort -> direkt einbuchen!
            await buchtArtikelZurueckInKiste(bestandsEintraege[0].id);
        } else if (bestandsEintraege.length > 1) {
            // Mehrere Orte -> Finder öffnen
            const art = alleArtikelInfos.find(a => String(a.id) === String(artikelId));
            oeffneWoGehoertDasHinModal(art?.name || '');
        } else {
            showToast('Artikel hat keinen festen Lagerort.', 'warning');
        }
        return;
    }

    showToast(`Code "${raw}" wurde nicht erkannt.`, 'error');
}

// NFC-Engine
async function starteKistenNfc() {
    if (aktiverNfcModus === 'kisten') {
        deaktiviereNfc();
        return showToast('NFC beendet.');
    }

    if (!('NDEFReader' in window) && typeof window.nfc === 'undefined') {
        return showToast('Web-NFC wird auf diesem Gerät/Browser nicht unterstützt.', 'error');
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

// NFC Schreiben für Lagerorte / Kisten
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

    if (!('NDEFReader' in window)) return showToast('NFC schreiben wird von diesem Browser nicht unterstützt.', 'error');
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
// 8. LAGER-MODUS (TABELLE & FILTER)
// =========================================================================

function wendeFilterAn() {
    const katFilter = $('kategorie-filter')?.value || 'ALLE';
    const comboFilter = $('ort-filter-combo')?.value || '';
    const suchText = $('such-filter')?.value.toLowerCase().trim() || '';

    let ortFilter = 'ALLE', regalTemp = '';
    if (comboFilter.startsWith('ort:')) ortFilter = comboFilter.substring(4);
    else if (comboFilter.startsWith('regal:')) regalTemp = comboFilter.substring(6);
    aktiverRegalFilter = regalTemp;

    let gefiltert = aktuelleDaten.filter(z => {
        if (suchText) {
            const matches = [z.artikel?.name, z.artikel?.kategorie, z.lagerorte?.name, String(z.artikel?.id ?? '')]
                .some(field => (field || '').toLowerCase().includes(suchText));
            if (!matches) return false;
        }
        if (aktiverRegalFilter && !(z.lagerorte?.name || '').toLowerCase().includes(aktiverRegalFilter.toLowerCase())) return false;
        if (katFilter !== 'ALLE' && z.artikel?.kategorie !== katFilter) return false;
        if (ortFilter !== 'ALLE' && String(z.lagerort_id) !== String(ortFilter)) return false;
        return true;
    });

    tabelleAktualisieren(gefiltert);
}

function ortComboChanged() {
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

function tabelleAktualisieren(daten) {
    const tbody = $('lager-tabelle');
    if (!tbody) return;
    tbody.innerHTML = '';

    const gruppen = {};
    daten.forEach(z => {
        if (!z.artikel) return;
        const kat = z.artikel.kategorie || 'Ohne Kategorie';
        if (!gruppen[kat]) gruppen[kat] = [];
        gruppen[kat].push(z);
    });

    const sortedKategorien = Object.keys(gruppen).sort((a, b) => a.localeCompare(b, 'de') * (sortAscending ? 1 : -1));

    if (sortedKategorien.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:25px; color:#666;">Keine Artikel gefunden.</td></tr>';
        return;
    }

    sortedKategorien.forEach(katName => {
        const zeilen = gruppen[katName];
        const isOpen = offeneGruppen.has(katName);

        const headerTr = document.createElement('tr');
        headerTr.style.cursor = 'pointer';
        headerTr.onclick = () => toggleGruppe(katName);
        headerTr.innerHTML = `
            <td colspan="3" style="background:#e2e8f0; font-weight:bold; padding:12px;">
                ${isOpen ? '📂' : '📁'} ${escapeHtml(katName)} (${zeilen.length})
            </td>`;
        tbody.appendChild(headerTr);
        if (!isOpen) return;

        // Artikel gruppieren
        const artMap = new Map();
        zeilen.forEach(z => {
            if (!artMap.has(z.artikel_id)) artMap.set(z.artikel_id, { artikel: z.artikel, bestaende: [] });
            artMap.get(z.artikel_id).bestaende.push(z);
        });

        artMap.forEach((grp, artId) => {
            const tr = document.createElement('tr');
            tr.style.cursor = isEditMode ? 'pointer' : 'default';
            tr.onclick = (e) => {
                if (!['INPUT', 'BUTTON', 'SVG', 'PATH'].includes(e.target.tagName)) openEditModal(artId);
            };

            let bestandRowsHtml = grp.bestaende.map(b => {
                const ist = Number(b.menge);
                const soll = Number(b.soll_menge);
                return `
                    <div class="bestand-ort-row">
                        <span class="bestand-ort-name">📍 ${escapeHtml(b.lagerorte?.name || '')}</span>
                        <div class="bestand-ort-qty-wrap">
                            <input type="number" value="${ist}" style="width:60px; padding:6px; text-align:center; border:1px solid #ccc; border-radius:4px;" 
                                   onchange="speichereMengeDirekt(${b.id}, this.value)">
                            <small class="bestand-einheit">${soll > 0 ? `/ ${soll}` : ''} ${escapeHtml(grp.artikel.einheit || 'Stück')}</small>
                        </div>
                    </div>`;
            }).join('');

            tr.innerHTML = `
                <td style="padding-left:25px;">
                    <strong>${escapeHtml(grp.artikel.name)}</strong>
                    ${grp.artikel.kommentar ? `<div style="font-size:0.8em; color:#3498db;">💬 ${escapeHtml(grp.artikel.kommentar)}</div>` : ''}
                </td>
                <td colspan="2">${bestandRowsHtml}</td>`;
            tbody.appendChild(tr);
        });
    });
}

async function speichereMengeDirekt(bestandId, val) {
    const neueMenge = Math.max(0, parseInt(val, 10) || 0);
    await dbClient.from('bestand').update({ menge: neueMenge }).eq('id', bestandId);
    showToast('Bestand aktualisiert!');
    await ladeAlles();
}

// =========================================================================
// 9. KISTEN-ANSICHT & ORTE VERWALTEN
// =========================================================================

function renderKistenListe() {
    const ziel = $('kisten-tabelle');
    if (!ziel) return;

    const filter = ($('kisten-such-filter')?.value || '').toLowerCase().trim();
    const liste = alleLagerorte.filter(o => !filter || o.name.toLowerCase().includes(filter) || (o.nfc_code || '').toLowerCase().includes(filter));

    if (!liste.length) {
        ziel.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Keine Orte gefunden.</td></tr>';
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
    openModalById('artikelModal');
}

async function artikelAnlegen() {
    const name = $('new-name').value.trim(), kat = $('new-kategorie').value.trim(), einheit = $('new-einheit').value;
    const wichtig = $('new-wichtig').checked;
    if (!name) return showToast('Bitte Namen eingeben.', 'warning');

    const { data, error } = await dbClient.from('artikel').insert([{ name, kategorie: kat, einheit, wichtig }]).select();
    if (error) return showToast('Fehler beim Anlegen: ' + error.message, 'error');

    const ortId = document.querySelector('.new-ort')?.value;
    const menge = parseInt(document.querySelector('.new-menge')?.value, 10) || 0;

    if (ortId) {
        await dbClient.from('bestand').insert([{
            artikel_id: data[0].id,
            lagerort_id: Number(ortId),
            menge,
            alte_menge: menge
        }]);
    }

    closeModal('artikelModal');
    showToast('Artikel gespeichert!');
    await ladeAlles();
}

async function openEditModal(artikelId) {
    if (!isEditMode) return;
    const art = alleArtikelInfos.find(a => a.id === artikelId);
    const bestaende = aktuelleDaten.filter(b => b.artikel_id === artikelId);

    $('edit-artikel-id').value = artikelId;
    $('edit-name').value = art.name;
    $('edit-kategorie').value = art.kategorie || '';
    $('edit-einheit').value = art.einheit || 'Stück';
    $('edit-wichtig').checked = Boolean(art.wichtig);

    const wrapper = $('edit-orte-wrapper');
    wrapper.innerHTML = '';
    bestaende.forEach(b => {
        const div = document.createElement('div');
        div.style = 'display:flex; gap:8px; margin-bottom:8px;';
        div.innerHTML = `
            <select class="edit-ort-select" style="flex:2; padding:8px; border-radius:4px; border:1px solid #ccc;">
                ${alleLagerorte.map(o => `<option value="${o.id}" ${o.id === b.lagerort_id ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}
            </select>
            <input type="number" class="edit-menge-val" value="${b.menge}" placeholder="Ist" style="width:70px; padding:8px; text-align:center; border:1px solid #ccc; border-radius:4px;">
            <input type="number" class="edit-soll-val" value="${b.soll_menge}" placeholder="Soll" title="Soll-Menge (Regulärer Kistenbestand)" style="width:70px; padding:8px; text-align:center; border:1px solid #27ae60; border-radius:4px;">
            <button type="button" class="btn" style="background:#e74c3c; width:auto; padding:6px 10px;" onclick="this.parentElement.remove()">🗑️</button>
        `;
        wrapper.appendChild(div);
    });

    openModalById('editModal');
}

function addEditOrtRow() {
    const wrapper = $('edit-orte-wrapper');
    const div = document.createElement('div');
    div.style = 'display:flex; gap:8px; margin-bottom:8px;';
    div.innerHTML = `
        <select class="edit-ort-select" style="flex:2; padding:8px; border-radius:4px; border:1px solid #ccc;">
            ${alleLagerorte.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}
        </select>
        <input type="number" class="edit-menge-val" value="1" placeholder="Ist" style="width:70px; padding:8px; text-align:center; border:1px solid #ccc; border-radius:4px;">
        <input type="number" class="edit-soll-val" value="1" placeholder="Soll" style="width:70px; padding:8px; text-align:center; border:1px solid #27ae60; border-radius:4px;">
        <button type="button" class="btn" style="background:#e74c3c; width:auto; padding:6px 10px;" onclick="this.parentElement.remove()">🗑️</button>
    `;
    wrapper.appendChild(div);
}

async function speichereBearbeitung() {
    const aid = $('edit-artikel-id').value;
    const name = $('edit-name').value.trim(), kat = $('edit-kategorie').value.trim(), einheit = $('edit-einheit').value;
    const wichtig = $('edit-wichtig').checked;

    await dbClient.from('artikel').update({ name, kategorie: kat, einheit, wichtig }).eq('id', aid);
    await dbClient.from('bestand').delete().eq('artikel_id', aid);

    const rows = document.querySelectorAll('#edit-orte-wrapper > div');
    const inserts = Array.from(rows).map(r => ({
        artikel_id: Number(aid),
        lagerort_id: Number(r.querySelector('.edit-ort-select').value),
        menge: parseInt(r.querySelector('.edit-menge-val').value, 10) || 0,
        alte_menge: parseInt(r.querySelector('.edit-soll-val').value, 10) || 0
    }));

    if (inserts.length) await dbClient.from('bestand').insert(inserts);

    closeModal('editModal');
    showToast('Artikel aktualisiert!');
    await ladeAlles();
}

async function artikelLoeschen() {
    if (!confirm('Diesen Artikel wirklich unwiderruflich löschen?')) return;
    const aid = $('edit-artikel-id').value;
    await dbClient.from('bestand').delete().eq('artikel_id', aid);
    await dbClient.from('artikel').delete().eq('id', aid);
    closeModal('editModal');
    showToast('Artikel gelöscht.');
    await ladeAlles();
}

// =========================================================================
// 11. EVENT-MODUS & INITIALISIERUNG
// =========================================================================
function wechsleModus(modus) {
    aktuellerModus = modus;
    ['lager', 'kisten', 'event'].forEach(m => {
        const v = $(`ansicht-${m}`), t = $(`tab-${m}`);
        if (v) v.style.display = m === modus ? 'block' : 'none';
        if (t) t.className = m === modus ? 'btn btn-modus active' : 'btn btn-modus';
    });
    if (modus === 'kisten') renderKistenListe();
    if (modus === 'event') ladeEventDaten();
}

async function ladeEventDaten() {
    const { data: lists } = await dbClient.from('packlisten').select('*').order('name');
    packlisten = lists || [];
    populateSelect($('packlisten-auswahl'), packlisten, { defaultOption: '-- Wähle Resort / Packliste --' });
    const { data: pos } = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie, einheit)');
    packlistenPositionen = pos || [];
    zeigePackliste();
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
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Noch keine Positionen.</td></tr>';
        return;
    }

    positionen.forEach(pos => {
        const bestandArtikel = aktuelleDaten.filter(b => b.artikel_id === pos.artikel_id);
        const verfuegbar = bestandArtikel.reduce((sum, b) => sum + (Number(b.menge) >= 0 ? Number(b.menge) : 0), 0);
        const ok = verfuegbar >= pos.menge;

        tbody.innerHTML += `
            <tr>
                <td><strong>${escapeHtml(pos.artikel?.name || 'Unbekannt')}</strong></td>
                <td>${pos.menge}</td>
                <td>${verfuegbar}</td>
                <td><span class="${ok ? 'event-ok' : 'event-warning'}">${ok ? '✅ OK' : '❌ Zu wenig'}</span></td>
            </tr>`;
    });
}

// Tool-Links
function oeffneEtikettenTool() { window.open('?etiketten=1', '_blank'); }

// Init beim Laden der Seite
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const kistenCode = params.get('kistencheck');
    const rueckgabeId = params.get('rueckgabe');

    const session = holeLokaleSession();
    if (session) {
        setzeAuthToken(session.token);
        $('login-overlay').style.display = 'none';
        await ladeAlles();

        if (kistenCode) {
            verarbeiteUniversalScan('kistencheck=' + kistenCode);
        } else if (rueckgabeId) {
            verarbeiteUniversalScan('rueckgabe=' + rueckgabeId);
        }
    } else {
        $('login-overlay').style.display = 'flex';
    }
});
const SUPABASE_URL = 'https://frrfjpnrewwlgfqtgjqg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZycmZqcG5yZXd3bGdmcXRnanFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTIyMDEsImV4cCI6MjA5MTgyODIwMX0.kfAyIBbO314WDzQHXzTlPFXpPQ92Ez_mgYbTY2TqxU4';
const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// GLOBALE VARIABLEN
let aktuelleDaten = [];
let packlisten = [];
let packlistenPositionen = [];
let alleArtikelInfos = []; 
let alleLagerorte = []; 
let isEditMode = false;
let isEventEditMode = false;
let aktuellerModus = 'lager'; 
let einkaufslisteArray = []; 

// Sortierung & Aufklappen
let offeneGruppen = new Set();
let isAllOpen = false;
let sortAscending = true;

// --- TOAST NOTIFICATIONS ---
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

// --- TOUCH UND HOVER LOGIK (LONG PRESS FÜR HANDY) ---
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

// --- HILFSFUNKTION: INLINE MATHE ---
function werteMengeAus(eingabe) {
    if (eingabe === undefined || eingabe === null) return 0;
    const saubererString = String(eingabe).replace(/[^0-9+\-*/().]/g, '');
    if (saubererString === '') return 0;
    try {
        const ergebnis = new Function('return ' + saubererString)();
        return Math.round(ergebnis); 
    } catch (e) { return 0; }
}

// --- AUTHENTIFIZIERUNG ---
document.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await dbClient.auth.getSession();
    if (session) { document.getElementById('login-overlay').style.display = 'none'; ladeAlles(); } 
    else { document.getElementById('login-overlay').style.display = 'flex'; }
});

dbClient.auth.onAuthStateChange(async (event, session) => {
    const overlay = document.getElementById('login-overlay');
    if (event === 'SIGNED_IN') { overlay.style.display = 'none'; showToast('Erfolgreich angemeldet!'); ladeAlles(); } 
    else if (event === 'SIGNED_OUT') {
        overlay.style.display = 'flex';
        document.getElementById('lager-tabelle').innerHTML = ''; 
    }
});

async function handleLogin() {
    const p = document.getElementById('login-password').value;
    const { error } = await dbClient.auth.signInWithPassword({ email: 'lager@trisported.de', password: p });
    if (error) document.getElementById('login-error').style.display = 'block';
    else { document.getElementById('login-error').style.display = 'none'; document.getElementById('login-password').value = ''; }
}
async function handleLogout() { await dbClient.auth.signOut(); }

// --- UI STEUERUNG ---
function wechsleModus(modus) {
    aktuellerModus = modus;
    document.getElementById('ansicht-lager').style.display = modus === 'lager' ? 'block' : 'none';
    document.getElementById('ansicht-event').style.display = modus === 'event' ? 'block' : 'none';
    
    document.getElementById('tab-lager').className = modus === 'lager' ? 'btn btn-modus active' : 'btn btn-modus';
    document.getElementById('tab-event').className = modus === 'event' ? 'btn btn-modus active' : 'btn btn-modus';
    
    if (modus === 'event') ladeEventDaten();
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function openModal() { 
    document.getElementById('new-name').value = '';
    document.getElementById('new-kategorie').value = '';
    
    // Löscht alle zusätzlich angeklickten Zeilen wieder raus
    const container = document.getElementById('new-orte-wrapper');
    const rows = container.querySelectorAll('.lagerort-row');
    for(let i = 1; i < rows.length; i++) {
        rows[i].remove();
    }
    
    // Setzt die allererste Zeile wieder auf Standard "0" und grauen Button zurück
    const firstRow = rows[0];
    const firstInput = firstRow.querySelector('.new-menge');
    firstInput.value = '0';
    firstInput.disabled = false;
    
    const firstBtnInf = firstRow.querySelector('.btn-inf');
    firstBtnInf.style.background = '#95a5a6';
    
    document.getElementById('artikelModal').style.display = 'block'; 
}

function addOrtRow() {
    const container = document.getElementById('new-orte-wrapper');
    const firstRow = container.querySelector('.lagerort-row');
    const newRow = firstRow.cloneNode(true); // Kopiert das Dropdown, Input-Feld und ∞ Button

    // Zurücksetzen des Input-Feldes und des Buttons in der neuen kopierten Zeile
    const input = newRow.querySelector('.new-menge');
    input.value = '0';
    input.disabled = false;
    
    const btnInf = newRow.querySelector('.btn-inf');
    btnInf.style.background = '#95a5a6';

    // Aus dem blauen ➕ Button am Ende einen roten 🗑️ (Löschen) Button machen
    const btnAddDelete = newRow.lastElementChild;
    btnAddDelete.innerHTML = '🗑️';
    btnAddDelete.style.backgroundColor = '#e74c3c';
    btnAddDelete.title = "Ort entfernen";
    btnAddDelete.onclick = function() { newRow.remove(); };

    container.appendChild(newRow);
}

// --- DATEN LADEN ---
async function ladeAlles() {
    await ladeLagerorte();
    
    const { data: listData } = await dbClient.from('packlisten').select('*');
    packlisten = listData || [];

    const resPos = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie)');
    packlistenPositionen = resPos.data || [];

    await ladeBestand();
    if(aktuellerModus === 'event') await ladeEventDaten();
}

async function ladeLagerorte() {
    const { data } = await dbClient.from('lagerorte').select('*').order('name');
    if (data) {
        alleLagerorte = data; 

        const selectsNeu = document.querySelectorAll('.new-ort');
        const selectEdit = document.getElementById('edit-ort');
        const filterOrt = document.getElementById('lagerort-filter'); 
        
        let aktuellerOrtFilter = filterOrt ? filterOrt.value : 'ALLE';
        
        selectsNeu.forEach(sel => sel.innerHTML = ''); 
        if(selectEdit) selectEdit.innerHTML = '';
        if(filterOrt) filterOrt.innerHTML = '<option value="ALLE">Alle Lagerorte</option>';

        data.forEach(o => {
            selectsNeu.forEach(sel => sel.add(new Option(o.name, o.id)));
            if(selectEdit) selectEdit.add(new Option(o.name, o.id));
            if(filterOrt) filterOrt.add(new Option(o.name, o.id));
        });

        if(filterOrt && Array.from(filterOrt.options).some(opt => opt.value === aktuellerOrtFilter)) {
            filterOrt.value = aktuellerOrtFilter;
        }
    }
}

async function ladeBestand() {
    const { data: alleArt } = await dbClient.from('artikel').select('*').order('name');
    alleArtikelInfos = alleArt || [];

    let { data, error } = await dbClient.from('bestand')
        .select(`id, menge, created_at, artikel_id, lagerort_id, artikel (id, name, kategorie), lagerorte (id, name)`).order('id');
    
    if (error) {
        console.warn("Spalte created_at fehlt in Supabase. Lade ohne Datum.");
        const fallback = await dbClient.from('bestand')
            .select(`id, menge, artikel_id, lagerort_id, artikel (id, name, kategorie), lagerorte (id, name)`).order('id');
        data = fallback.data;
        if (fallback.error) { showToast("Datenbank-Fehler", "error"); return; }
    }

    aktuelleDaten = data || []; 
    aktualisiereFilterDropdown(aktuelleDaten); 
    wendeFilterAn(); 
}

// === LAGER MODUS LOGIK ===
function aktualisiereFilterDropdown(daten) {
    const dropdown = document.getElementById('kategorie-filter');
    if (!dropdown) return;
    const aktuelleAuswahl = dropdown.value;
    const kategorien = new Set();
    daten.forEach(z => { 
        if (z.artikel && z.artikel.kategorie && z.artikel.kategorie.trim() !== '') {
            kategorien.add(z.artikel.kategorie.trim()); 
        }
    });
    dropdown.innerHTML = '<option value="ALLE">Alle Kategorien</option>';
    Array.from(kategorien).sort().forEach(kat => dropdown.add(new Option(kat, kat)));
    if (Array.from(dropdown.options).some(opt => opt.value === aktuelleAuswahl)) dropdown.value = aktuelleAuswahl;
}

function wendeFilterAn() {
    const katFilter = document.getElementById('kategorie-filter')?.value || 'ALLE';
    const ortFilter = document.getElementById('lagerort-filter')?.value || 'ALLE';
    const suchText = document.getElementById('such-filter')?.value.toLowerCase().trim() || '';
    
    let gefilterteDaten = aktuelleDaten;

    // Suchen
    if (suchText !== '') {
        gefilterteDaten = gefilterteDaten.filter(z => 
            (z.artikel?.name || '').toLowerCase().includes(suchText) ||
            (z.artikel?.kategorie || '').toLowerCase().includes(suchText) ||
            (z.lagerorte?.name || '').toLowerCase().includes(suchText)
        );
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
    const isSearching = suchText.length > 0;
    
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

    const gruppierteDaten = {}; 
    daten.forEach(zeile => {
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
    for (const katName of sortedKategorien) {
        const zeilenListe = gruppierteDaten[katName];
        
        // Ordner automatisch öffnen, wenn gesucht wird
        const isOpen = offeneGruppen.has(katName) || isSearching;
        const icon = isOpen ? '📂' : '📁';

        let ordnerSumme = 0;
        let hatUnendlich = false;
        zeilenListe.forEach(z => {
            if(Number(z.menge) === -1) hatUnendlich = true;
            else ordnerSumme += Number(z.menge);
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
                    <span>${icon} ${katName}</span>
                    <span class="summen-badge">Gesamt: ${summenAnzeige}</span>
                </div>
            </td>
        `;
        tbody.appendChild(headerTr);

        if (!isOpen) continue;

        const prefixCounts = {};
        zeilenListe.forEach(z => {
            const parts = z.artikel.name.trim().split(' ');
            if (parts.length > 1) { 
                const prefix = parts[0];
                prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
            }
        });

        zeilenListe.sort((a, b) => {
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
        // 1. Gruppieren nach Artikel-ID (statt nach einzelnen Beständen)
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

        // 2. Tabellenzeilen für jeden Artikel generieren
        artikelGruppen.forEach((gruppe, artId) => {
            const aName = gruppe.artikel.name.trim();
            const parts = aName.split(' ');
            const isGroup = parts.length > 1 && prefixCounts[parts[0]] > 1;
            const prefix = isGroup ? parts[0] : null;

            // Logik für die grauen Unterordner (Prefix)
            if (isGroup && currentPrefix !== prefix) {
                const subGroupTr = document.createElement('tr');
                subGroupTr.innerHTML = `<td colspan="3" style="padding-left: 25px; background: #fafafa; color: #7f8c8d; font-size: 0.85em; font-weight: bold; border-bottom: 1px dashed #ddd; user-select: none;">🏷️ ${prefix}</td>`;
                tbody.appendChild(subGroupTr);
                currentPrefix = prefix;
            } else if (!isGroup) {
                currentPrefix = null;
            }

            const tr = document.createElement('tr');
            tr.style.cursor = isEditMode ? "pointer" : "default";

            // WICHTIG: Klick öffnet jetzt den Artikel, nicht den Bestand
            tr.onclick = (e) => { 
                if(hoverWasLongPress) return;
                if(e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') openEditModal(artId); 
            };

            let displayName = gruppe.artikel.name;
            let indent = 25;
            let iconLabel = '↳';

            if (isGroup) {
                indent = 45;
                iconLabel = '◦';
                displayName = displayName.substring(prefix.length).trim(); 
            }

            // Reservierungen checken
            let isInfinite = gruppe.bestaende.some(b => Number(b.menge) === -1);
            let resHtml = '';
            const resInfo = reservierungenDetails[artId];
            if (resInfo && resInfo.gesamt > 0 && !isInfinite) {
                let hoverText = "<strong>Reserviert für:</strong><br>";
                for (const [lName, lMenge] of Object.entries(resInfo.listen)) {
                    const safeLName = lName.replace(/'/g, "´").replace(/"/g, "´´");
                    hoverText += `• ${lMenge}x in <i>${safeLName}</i><br>`;
                }
                resHtml = `<div class="no-select" style="font-size: 0.75em; color: #d35400; margin-top: 5px; font-weight: normal; cursor: help; display: inline-block;"
                    data-hover-type="res" data-hover-content="${hoverText}"
                    onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)"
                    ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)">
                    📦 Reserviert: ${resInfo.gesamt}
                </div>`;
            }

            // HTML für die verschiedenen Lagerorte und Mengen des Artikels zusammenbauen
            let bestandInfoHtml = "";
            gruppe.bestaende.forEach(b => {
                const isInfLocal = (Number(b.menge) === -1);
                let mengeZelle = "";
                if (isInfLocal) {
                    mengeZelle = `<span style="font-size: 1.2em; color: #7f8c8d; font-weight: bold;" title="Verbrauchsartikel (Unendlich)">∞</span>`;
                } else {
                    mengeZelle = `<input type="text" id="menge-${b.id}" class="menge-input" value="${b.menge}" onchange="speichereMenge(${b.id})" style="width: 70px;">`;
                }

                bestandInfoHtml += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid #f0f0f0; padding-bottom: 4px;">
                        <span style="font-size: 0.9em; color: #666;">📍 ${b.lagerorte.name}</span>
                        ${mengeZelle}
                    </div>`;
            });

            tr.innerHTML = `
                <td class="no-select" style="padding-left: ${indent}px; color:#333; vertical-align: top;">
                    ${iconLabel} <strong>${displayName}</strong>
                </td>
                <td colspan="2" style="vertical-align: top;">
                    ${bestandInfoHtml}
                    ${resHtml ? '<div>' + resHtml + '</div>' : ''}
                </td>
            `;
            tbody.appendChild(tr);
        });
    }
}

function toggleEditMode() {
    isEditMode = !isEditMode;
    const b = document.getElementById('btn-edit-mode');
    if(b) { b.innerText = isEditMode ? "✏️ Bearbeiten: AN" : "✏️ Bearbeiten: AUS"; b.style.backgroundColor = isEditMode ? "#e67e22" : "#f39c12"; }
    wendeFilterAn();
}

// Neue Funktion: Steuert das Sperren/Entsperren der Mengen-Felder
// Neue Funktion: Schaltet die Unendlich-Menge nur für EINE Zeile um
function toggleRowInfinite(btn) {
    const input = btn.previousElementSibling; // Holt das Input-Feld links neben dem Button
    if (input.value === '∞') {
        input.disabled = false;
        input.value = input.dataset.oldValue || '0';
        btn.style.background = '#95a5a6'; // Grau = aus
    } else {
        input.dataset.oldValue = input.value;
        input.value = '∞';
        input.disabled = true;
        btn.style.background = '#27ae60'; // Grün = aktiv
    }
}

function addEditOrtRow(data = null) {
    const wrapper = document.getElementById('edit-orte-wrapper');
    const div = document.createElement('div');
    div.className = 'edit-ort-row';
    div.style = 'display: flex; gap: 8px; margin-bottom: 8px; align-items: center;';
    
    let options = alleLagerorte.map(o => `<option value="${o.id}" ${data && data.lagerort_id == o.id ? 'selected' : ''}>${o.name}</option>`).join('');
    
    // Bestimme den anzuzeigenden Wert (wird pro Ort aus der Datenbank gelesen)
    let displayVal = '0';
    if (data) {
        displayVal = (data.menge == -1) ? '∞' : data.menge;
    }

    const btnColor = (displayVal === '∞') ? '#27ae60' : '#95a5a6'; // Wenn unendlich, wird der Button gleich grün

    div.innerHTML = `
        <select class="edit-ort-select" style="flex: 2; padding: 10px; border-radius: 6px; border: 1px solid #ccc;">${options}</select>
        
        <div style="flex: 1; display: flex; gap: 4px;">
            <input type="text" class="edit-menge-input" value="${displayVal}" style="width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #ccc; text-align: center;" ${displayVal === '∞' ? 'disabled' : ''}>
            <button type="button" class="btn" style="background: ${btnColor}; padding: 8px 12px; width: auto; min-width: 40px; font-weight: bold;" title="Unendlich umschalten" onclick="toggleRowInfinite(this)">∞</button>
        </div>

        <button type="button" class="btn" style="background:#e74c3c; padding: 8px 12px; width: auto; min-width: 40px;" onclick="removeEditRow(this)">🗑️</button>
    `;
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

    const wrapper = document.getElementById('edit-orte-wrapper');
    wrapper.innerHTML = '';
    
    // Vorhandene Bestände laden (Jede Zeile weiß jetzt selbst, ob sie ∞ ist)
    bestaende.forEach(b => addEditOrtRow(b));
    if(bestaende.length === 0) addEditOrtRow();

    document.getElementById('editModal').style.display = 'block';
}

async function speichereBearbeitung() {
    try {
        const aid = document.getElementById('edit-artikel-id').value;
        const nName = document.getElementById('edit-name').value;
        const nKat = document.getElementById('edit-kategorie').value;

        // 1. Artikel-Basisdaten (Name/Kat) updaten
        await dbClient.from('artikel').update({ name: nName, kategorie: nKat }).eq('id', aid);

        // 2. Alle alten Bestände dieses Artikels löschen
        await dbClient.from('bestand').delete().eq('artikel_id', aid);

        // 3. Alle neuen Zeilen sammeln und einfügen
        const inserts = [];
        document.querySelectorAll('.edit-ort-row').forEach(row => {
            const oid = row.querySelector('.edit-ort-select').value;
            const input = row.querySelector('.edit-menge-input');
            const mRaw = input.value;
            
            // Rechnet aus, ob der Wert unendlich (-1) oder eine Zahl ist
            const menge = (mRaw === '∞') ? -1 : werteMengeAus(mRaw);
            
            inserts.push({ artikel_id: aid, lagerort_id: oid, menge: menge });
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
        // Erst Bestände löschen, dann den Artikel
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
    
    const neueMenge = werteMengeAus(f.value);
    f.value = neueMenge; 
    f.style.backgroundColor = '#fff3cd'; 

    const aktuellesDatum = new Date().toISOString();
    
    let { error } = await dbClient.from('bestand').update({ menge: neueMenge, created_at: aktuellesDatum }).eq('id', bId);
    if (error) {
        const fallback = await dbClient.from('bestand').update({ menge: neueMenge }).eq('id', bId);
        error = fallback.error;
    }
    
    if (!error) {
        f.style.backgroundColor = '#d4edda'; 
        showToast(`Bestand gespeichert: ${neueMenge}`);
        setTimeout(() => { if(f) f.style.backgroundColor = ''; ladeAlles(); }, 800); 
    } else { showToast("Speicherfehler!", "error"); }
}

async function artikelAnlegen() {
    try {
        const n = document.getElementById('new-name').value;
        const k = document.getElementById('new-kategorie').value;
        
        if (!n) { showToast("Bitte einen Namen eingeben!", "warning"); return; }

        // 1. Artikel in der Datenbank anlegen
        const { data: nA, error: err } = await dbClient.from('artikel').insert([{ name: n, kategorie: k }]).select();
        if (err) { showToast("Fehler: " + err.message, "error"); return; }
        
        // 2. Alle angelegten Orte und Mengen auslesen
        const bestandInserts = [];
        const rows = document.querySelectorAll('#new-orte-wrapper .lagerort-row');
        
        rows.forEach(row => {
            const ortSelect = row.querySelector('.new-ort').value;
            const mengeInput = row.querySelector('.new-menge').value;
            
            // Rechnet aus, ob der Wert unendlich (-1) oder eine Zahl ist
            const berechneteMenge = (mengeInput === '∞') ? -1 : werteMengeAus(mengeInput);
            
            bestandInserts.push({ 
                artikel_id: nA[0].id, 
                lagerort_id: ortSelect, 
                menge: berechneteMenge 
            });
        });
        
        // 3. Alle Lagerorte (Bestände) auf einmal in die DB schreiben
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

// --- LAGERORTE VERWALTEN ---
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


// === EVENT MODUS LOGIK ===
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

        const resPos = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie)');
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
            
            aktuelleDaten.forEach(b => { 
                if(b.artikel_id === pos.artikel_id) {
                    if(Number(b.menge) === -1) hatUnendlich = true;
                    gesamtLager += Number(b.menge); 
                }
            });
            
            if (hatUnendlich) {
                availableHtml = `<span style="font-size:1.2em; font-weight:bold;">∞</span>`;
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
            anzeigeName = pos.eigener_name + " <small style='color:#999;'>(Eigener)</small>";
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
    zeigePackliste();
}

function openPackItemModal() {
    const listId = document.getElementById('packlisten-auswahl').value;
    if (!listId) { showToast("Bitte wähle zuerst eine Packliste aus!", "warning"); return; }
    
    const sel = document.getElementById('pack-artikel-select');
    sel.innerHTML = '';
    
    const sortierteArt = [...alleArtikelInfos].sort((a, b) => {
        const aKat = a.kategorie || '';
        const bKat = b.kategorie || '';
        if (aKat !== bKat) return aKat.localeCompare(bKat, 'de');
        return a.name.localeCompare(b.name, 'de');
    });

    sortierteArt.forEach(art => {
        const nameString = (art.kategorie ? art.kategorie + " > " : "") + art.name;
        sel.add(new Option(nameString, art.id));
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

    const selId = Number(document.getElementById('pack-artikel-select').value);
    if (!selId) { infoDiv.innerHTML = ''; return; }

    let gesamtLager = 0;
    let hatUnendlich = false;
    aktuelleDaten.forEach(b => { 
        if(b.artikel_id === selId) {
            if(Number(b.menge) === -1) hatUnendlich = true;
            gesamtLager += Number(b.menge); 
        }
    });

    if (hatUnendlich) {
        infoDiv.innerHTML = `✅ Verbrauchsartikel (Unendlich auf Lager)`;
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
        dbObj.artikel_id = document.getElementById('pack-artikel-select').value;
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

// ==========================================
// --- EINKAUFSLISTE UND EXCEL EXPORT ---
// ==========================================

function startEinkaufsliste() {
    einkaufslisteArray = []; 

    let artikelBestand = {};
    let artikelUnendlich = new Set();
    
    aktuelleDaten.forEach(b => {
        if (Number(b.menge) === -1) {
            artikelUnendlich.add(b.artikel_id);
        } else {
            artikelBestand[b.artikel_id] = (artikelBestand[b.artikel_id] || 0) + Number(b.menge);
        }
    });

    let artikelBedarf = {};
    let eigeneGegenstaende = {}; 

    packlistenPositionen.forEach(p => {
        if (p.artikel_id) {
            if (!artikelUnendlich.has(p.artikel_id)) {
                artikelBedarf[p.artikel_id] = (artikelBedarf[p.artikel_id] || 0) + Number(p.menge);
            }
        } else if (p.eigener_name) {
            eigeneGegenstaende[p.eigener_name] = (eigeneGegenstaende[p.eigener_name] || 0) + Number(p.menge);
        }
    });

    const ulAuto = document.getElementById('auto-kauf-liste');
    ulAuto.innerHTML = '';

    alleArtikelInfos.forEach(art => {
        let bestand = artikelBestand[art.id] || 0;
        let bedarf = artikelBedarf[art.id] || 0;
        
        if (bedarf > bestand && !artikelUnendlich.has(art.id)) {
            let fehlMenge = bedarf - bestand;
            einkaufslisteArray.push({ artikel: art.name, menge: fehlMenge, grund: 'Fehlt im Lager' });
            ulAuto.innerHTML += `<li>${fehlMenge}x ${art.name}</li>`;
        }
    });

    for (let name in eigeneGegenstaende) {
        einkaufslisteArray.push({ artikel: name, menge: eigeneGegenstaende[name], grund: 'Sonderposten Packliste' });
        ulAuto.innerHTML += `<li>${eigeneGegenstaende[name]}x ${name} <small style="color:#666;">(Sonderposten)</small></li>`;
    }

    if (einkaufslisteArray.length === 0) {
        ulAuto.innerHTML = '<li style="color:#27ae60;">Alles grün! Das Lager deckt alle Listen ab.</li>';
    }

    document.getElementById('manuell-kauf-liste').innerHTML = '';
    document.getElementById('kauflisteModal').style.display = 'block';
}

function manuellAufZettel() {
    const nameFeld = document.getElementById('manuell-kauf-name');
    const mengeFeld = document.getElementById('manuell-kauf-menge');
    const name = nameFeld.value.trim();
    const menge = werteMengeAus(mengeFeld.value); 

    if (!name || menge <= 0) return;

    einkaufslisteArray.push({ artikel: name, menge: menge, grund: 'Manuell hinzugefügt' });
    
    const ulManuell = document.getElementById('manuell-kauf-liste');
    ulManuell.innerHTML += `<li>${menge}x ${name}</li>`;

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

    // Ermittle den Basis-Pfad
    const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf("/") + 1);

    const printWindow = window.open('', '_blank');
    
    let html = `
        <html>
        <head>
            <title>Packliste: ${liste.name}</title>
            <style>
                body { font-family: sans-serif; padding: 20px; color: #333; }
                
                /* Layout für den Kopfbereich (Text links, Logo rechts) */
                .header-container {
                    display: flex;
                    justify-content: space-between;
                    align-items: center; /* Zentriert beides auf gleicher Höhe */
                    border-bottom: 2px solid #e3000f;
                    padding-bottom: 15px;
                    margin-bottom: 20px;
                }
                
                .header-text h1 { 
                    color: #e3000f; 
                    margin: 0 0 5px 0; /* Abstände anpassen, da der Rahmen jetzt im Container ist */
                }
                
                .header-text p {
                    margin: 0;
                    color: #666;
                }
                
                /* Styling für das Logo in der Ecke */
                .corner-logo { 
                    height: 60px; /* Hier kannst du einstellen, wie groß das Logo sein soll */
                    width: auto; 
                }

                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
                th { background-color: #f2f2f2; }
                .check { width: 30px; border: 1px solid #333; height: 20px; display: inline-block; }
                
                @media print { 
                    .no-print { display: none; } 
                    tr { page-break-inside: avoid; }
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
                    <tr>
                        <th>Gepackt</th>
                        <th>Gegenstand / Material</th>
                        <th>Menge</th>
                        <th>Lagerort</th>
                    </tr>
                </thead>
                <tbody>`;

    positionen.forEach(pos => {
        let name = "";
        let ort = "-";

        if (pos.artikel_id && pos.artikel) {
            name = (pos.artikel.kategorie ? pos.artikel.kategorie + " > " : "") + pos.artikel.name;
            const bestandInfo = aktuelleDaten.find(b => b.artikel_id === pos.artikel_id);
            if (bestandInfo && bestandInfo.lagerorte) {
                ort = bestandInfo.lagerorte.name;
            }
        } else {
            name = pos.eigener_name + " (Manuell)";
            ort = "Nicht im Lager";
        }

        html += `
            <tr>
                <td style="text-align:center; width: 60px;"><div class="check"></div></td>
                <td><strong>${name}</strong></td>
                <td style="width: 80px;">${pos.menge}</td>
                <td>${ort}</td>
            </tr>`;
    });

    html += `
                </tbody>
            </table>
            
            <div style="margin-top: 30px; font-size: 0.8em; color: #666; text-align: center;">
                Trisport Erding Lager-Verwaltung
            </div>
        </body>
        </html>`;

    printWindow.document.write(html);
    printWindow.document.close();
}
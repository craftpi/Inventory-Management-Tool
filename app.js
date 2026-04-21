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
    document.getElementById('new-menge').value = '0';
    document.getElementById('new-menge').disabled = false;
    document.getElementById('new-is-infinite').checked = false;
    document.getElementById('artikelModal').style.display = 'block'; 
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

        const selectNeu = document.getElementById('new-ort');
        const selectEdit = document.getElementById('edit-ort');
        const filterOrt = document.getElementById('lagerort-filter'); 
        
        let aktuellerOrtFilter = filterOrt ? filterOrt.value : 'ALLE';
        
        if(selectNeu) selectNeu.innerHTML = ''; 
        if(selectEdit) selectEdit.innerHTML = '';
        if(filterOrt) filterOrt.innerHTML = '<option value="ALLE">Alle Lagerorte</option>';

        data.forEach(o => {
            if(selectNeu) selectNeu.add(new Option(o.name, o.id));
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

        zeilenListe.forEach((z) => {
            const parts = z.artikel.name.trim().split(' ');
            const isGroup = parts.length > 1 && prefixCounts[parts[0]] > 1;
            const prefix = isGroup ? parts[0] : null;

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
            
            tr.onclick = (e) => { 
                if(hoverWasLongPress) return;
                if(e.target.tagName !== 'INPUT') openEditModal(z.id); 
            };
            
            let displayName = z.artikel.name;
            let indent = 25;
            let iconLabel = '↳';

            if (isGroup) {
                indent = 45;
                iconLabel = '◦';
                displayName = displayName.substring(prefix.length).trim(); 
            }
            
            let dateStr = 'Unbekannt';
            if (z.created_at) {
                const d = new Date(z.created_at);
                dateStr = d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', {hour: '2-digit', minute:'2-digit'}) + ' Uhr';
            }

            let isInfinite = (Number(z.menge) === -1);
            let resHtml = '';
            
            const resInfo = reservierungenDetails[z.artikel_id];
            if (resInfo && resInfo.gesamt > 0 && !isInfinite) {
                let hoverText = "<strong>Reserviert für:</strong><br>";
                for (const [lName, lMenge] of Object.entries(resInfo.listen)) {
                    const safeLName = lName.replace(/'/g, "´").replace(/"/g, "´´");
                    hoverText += `• ${lMenge}x in <i>${safeLName}</i><br>`;
                }
                resHtml = `<div class="no-select" style="font-size: 0.75em; color: #d35400; margin-top: 5px; font-weight: normal; cursor: help; display: inline-block;"
                    data-hover-type="res" data-hover-content="${hoverText}"
                    onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)"
                    ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)"
                    oncontextmenu="event.preventDefault(); return false;">
                    📦 Reserviert: ${resInfo.gesamt}
                </div>`;
            }

            let mengeZelle = "";
            if (isInfinite) {
                mengeZelle = `<span style="font-size: 1.5em; color: #7f8c8d; font-weight: bold;" title="Verbrauchsartikel (Unendlich)">∞</span>`;
            } else {
                mengeZelle = `<input type="text" id="menge-${z.id}" class="menge-input" value="${z.menge}" onchange="speichereMenge(${z.id})" placeholder="z.B. 5+2">`;
            }
            
            tr.innerHTML = `
                <td class="no-select" style="padding-left: ${indent}px; color:#333;"
                    data-hover-type="date" data-hover-content="${dateStr}"
                    onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)"
                    ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)"
                    oncontextmenu="event.preventDefault(); return false;">
                    ${iconLabel} <strong>${displayName}</strong>
                </td>
                <td style="color:#666;">📍 ${z.lagerorte.name}</td>
                <td>
                    ${mengeZelle}
                    ${resHtml ? '<br>' + resHtml : ''}
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

function openEditModal(bId) {
    if (!isEditMode) return; 
    const z = aktuelleDaten.find(x => x.id === bId);
    if (!z) return;
    
    document.getElementById('edit-bestand-id').value = z.id;
    document.getElementById('edit-artikel-id').value = z.artikel_id;
    document.getElementById('edit-name').value = z.artikel.name;
    document.getElementById('edit-kategorie').value = z.artikel.kategorie || '';
    document.getElementById('edit-ort').value = z.lagerort_id;
    
    const isInfinite = (Number(z.menge) === -1);
    document.getElementById('edit-is-infinite').checked = isInfinite;
    const mengeFeld = document.getElementById('edit-menge');
    mengeFeld.disabled = isInfinite;
    mengeFeld.value = isInfinite ? '∞' : z.menge;
    
    document.getElementById('editModal').style.display = 'block';
}

async function speichereBearbeitung() {
    try {
        const bId = document.getElementById('edit-bestand-id').value;
        const aId = document.getElementById('edit-artikel-id').value;
        const nName = document.getElementById('edit-name').value;
        const nKat = document.getElementById('edit-kategorie').value;
        const nOrt = document.getElementById('edit-ort').value;
        
        const isInf = document.getElementById('edit-is-infinite').checked;
        const nMenge = isInf ? -1 : werteMengeAus(document.getElementById('edit-menge').value);
        const aktuellesDatum = new Date().toISOString();

        // SAUBERES UPDATE (Nur Kategorie)
        await dbClient.from('artikel').update({ name: nName, kategorie: nKat }).eq('id', aId);
        
        const { data: ex } = await dbClient.from('bestand').select('id, menge').eq('artikel_id', aId).eq('lagerort_id', nOrt).neq('id', bId).maybeSingle(); 
        
        if (ex && !isInf && Number(ex.menge) !== -1) {
            let res = await dbClient.from('bestand').update({ menge: Number(ex.menge) + nMenge, created_at: aktuellesDatum }).eq('id', ex.id);
            if(res.error) await dbClient.from('bestand').update({ menge: Number(ex.menge) + nMenge }).eq('id', ex.id);
            
            await dbClient.from('bestand').delete().eq('id', bId);
        } else { 
            let res = await dbClient.from('bestand').update({ lagerort_id: nOrt, menge: nMenge, created_at: aktuellesDatum }).eq('id', bId); 
            if(res.error) await dbClient.from('bestand').update({ lagerort_id: nOrt, menge: nMenge }).eq('id', bId);
        }
        
        closeModal('editModal'); 
        showToast('Artikel aktualisiert!');
        ladeAlles(); 
    } catch(e) { showToast("Fehler beim Speichern", "error"); console.error(e); }
}

async function artikelLoeschen() {
    if(confirm("Diesen Eintrag wirklich löschen?")) {
        await dbClient.from('bestand').delete().eq('id', document.getElementById('edit-bestand-id').value);
        closeModal('editModal'); 
        showToast('Artikel gelöscht');
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
        const o = document.getElementById('new-ort').value; 
        
        const isInf = document.getElementById('new-is-infinite').checked;
        const m = isInf ? -1 : werteMengeAus(document.getElementById('new-menge').value);
        
        if (!n) { showToast("Bitte einen Namen eingeben!", "warning"); return; }

        // SAUBERER INSERT (Nur Kategorie)
        const { data: nA, error: err } = await dbClient.from('artikel').insert([{ name: n, kategorie: k }]).select();
        if (err) { showToast("Fehler: " + err.message, "error"); return; }
        
        await dbClient.from('bestand').insert([{ artikel_id: nA[0].id, lagerort_id: o, menge: m }]);
        
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
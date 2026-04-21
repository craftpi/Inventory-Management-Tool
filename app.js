const SUPABASE_URL = 'https://frrfjpnrewwlgfqtgjqg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZycmZqcG5yZXd3bGdmcXRnanFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTIyMDEsImV4cCI6MjA5MTgyODIwMX0.kfAyIBbO314WDzQHXzTlPFXpPQ92Ez_mgYbTY2TqxU4';
const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// GLOBALE VARIABLEN
let aktuelleDaten = [];
let packlisten = [];
let packlistenPositionen = [];
let alleArtikelInfos = []; 
let isEditMode = false;
let isEventEditMode = false;
let aktuellerModus = 'lager'; 
let einkaufslisteArray = []; 

// Sortierung & Aufklappen
let offeneGruppen = new Set();
let isAllOpen = false;
let sortAscending = true;

// --- TOAST NOTIFICATIONS (Professionelles Feedback) ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    
    // Animation starten
    setTimeout(() => toast.classList.add('show'), 10);
    // Nach 3 Sekunden verschwinden lassen
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- HILFSFUNKTION: INLINE MATHE ---
function werteMengeAus(eingabe) {
    if (eingabe === undefined || eingabe === null) return 0;
    // Erlaubt nur Zahlen und Rechenzeichen
    const saubererString = String(eingabe).replace(/[^0-9+\-*/().]/g, '');
    if (saubererString === '') return 0;
    try {
        const ergebnis = new Function('return ' + saubererString)();
        return Math.round(ergebnis); // Immer auf ganze Zahlen runden
    } catch (e) {
        return 0; // Bei Quatsch-Eingabe
    }
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
    await ladeBestand();
    if(aktuellerModus === 'event') await ladeEventDaten();
}

async function ladeLagerorte() {
    const { data } = await dbClient.from('lagerorte').select('*').order('name');
    if (data) {
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

    // Lade Artikel. Wir brauchen 'gruppe' nicht mehr, nutzen nur 'kategorie'
    const { data, error } = await dbClient.from('bestand')
        .select(`id, menge, artikel_id, lagerort_id, artikel (id, name, kategorie), lagerorte (id, name)`).order('id');
    
    if (error) { showToast("Datenbank-Fehler beim Laden", "error"); return; }
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
    
    let gefilterteDaten = aktuelleDaten;

    if (katFilter !== 'ALLE') {
        gefilterteDaten = gefilterteDaten.filter(z => z.artikel && z.artikel.kategorie === katFilter);
    }
    
    if (ortFilter !== 'ALLE') {
        gefilterteDaten = gefilterteDaten.filter(z => String(z.lagerort_id) === String(ortFilter));
    }

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
    
    if (isAllOpen) {
        aktuelleDaten.forEach(zeile => {
            if (!zeile.artikel) return;
            const katName = zeile.artikel.kategorie || 'Ohne Kategorie';
            offeneGruppen.add(katName);
        });
    }
    wendeFilterAn();
}

function tabelleAktualisieren(daten) {
    const tbody = document.getElementById('lager-tabelle');
    if (!tbody) return;
    tbody.innerHTML = ''; 
    
    const gruppierteDaten = {}; 
    
    // Gruppieren nur noch nach Kategorie
    daten.forEach(zeile => {
        if (!zeile.artikel) return; 
        const katName = zeile.artikel.kategorie || 'Ohne Kategorie';
        if (!gruppierteDaten[katName]) { gruppierteDaten[katName] = []; }
        gruppierteDaten[katName].push(zeile); 
    });

    const sortFactor = sortAscending ? 1 : -1;
    // Kategorien alphabetisch sortieren
    const sortedKategorien = Object.keys(gruppierteDaten).sort((a, b) => a.localeCompare(b, 'de') * sortFactor);

    for (const katName of sortedKategorien) {
        const zeilenListe = gruppierteDaten[katName];
        const isOpen = offeneGruppen.has(katName);
        const icon = isOpen ? '📂' : '📁';

        // Summe für den Ordner berechnen (-1 wird ignoriert und als ∞ markiert)
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

        // Artikel innerhalb der Kategorie alphabetisch sortieren
        zeilenListe.sort((a, b) => a.artikel.name.localeCompare(b.artikel.name, 'de') * sortFactor);

        zeilenListe.forEach((z) => {
            const tr = document.createElement('tr');
            tr.style.cursor = isEditMode ? "pointer" : "default";
            tr.onclick = (e) => { if(e.target.tagName !== 'INPUT') openEditModal(z.id); };
            
            let mengeZelle = "";
            if (Number(z.menge) === -1) {
                // Anzeige für Verbrauchsartikel
                mengeZelle = `<span style="font-size: 1.5em; color: #7f8c8d; font-weight: bold;" title="Verbrauchsartikel (Unendlich)">∞</span>`;
            } else {
                mengeZelle = `<input type="text" id="menge-${z.id}" class="menge-input" value="${z.menge}" onchange="speichereMenge(${z.id})" placeholder="z.B. 5+2">`;
            }
            
            tr.innerHTML = `
                <td style="padding-left: 25px; color:#333;">↳ <strong>${z.artikel.name}</strong></td>
                <td style="color:#666;">📍 ${z.lagerorte.name}</td>
                <td>${mengeZelle}</td>
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

        await dbClient.from('artikel').update({ name: nName, kategorie: nKat }).eq('id', aId);
        
        // Prüfen, ob am neuen Lagerort schon was liegt, um es zusammenzufassen
        const { data: ex } = await dbClient.from('bestand').select('id, menge').eq('artikel_id', aId).eq('lagerort_id', nOrt).neq('id', bId).maybeSingle(); 
        
        if (ex && !isInf && Number(ex.menge) !== -1) {
            await dbClient.from('bestand').update({ menge: Number(ex.menge) + nMenge }).eq('id', ex.id);
            await dbClient.from('bestand').delete().eq('id', bId);
        } else { 
            await dbClient.from('bestand').update({ lagerort_id: nOrt, menge: nMenge }).eq('id', bId); 
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
    
    // Die Mathematik-Magie anwenden! Aus "35+23" wird 58
    const neueMenge = werteMengeAus(f.value);
    f.value = neueMenge; // Feld direkt aktualisieren
    f.style.backgroundColor = '#fff3cd'; 

    const { error } = await dbClient.from('bestand').update({ menge: neueMenge }).eq('id', bId);
    if (!error) {
        f.style.backgroundColor = '#d4edda'; 
        showToast(`Bestand gespeichert: ${neueMenge}`);
        setTimeout(() => { if(f) f.style.backgroundColor = ''; ladeAlles(); }, 800); 
    } else {
        showToast("Speicherfehler!", "error");
    }
}

async function artikelAnlegen() {
    try {
        const n = document.getElementById('new-name').value;
        const k = document.getElementById('new-kategorie').value;
        const o = document.getElementById('new-ort').value; 
        
        const isInf = document.getElementById('new-is-infinite').checked;
        const m = isInf ? -1 : werteMengeAus(document.getElementById('new-menge').value);
        
        if (!n) { showToast("Bitte einen Namen eingeben!", "warning"); return; }

        const { data: nA, error: err } = await dbClient.from('artikel').insert([{ name: n, kategorie: k }]).select();
        if (err) { showToast("Fehler: " + err.message, "error"); return; }
        
        await dbClient.from('bestand').insert([{ artikel_id: nA[0].id, lagerort_id: o, menge: m }]);
        
        closeModal('artikelModal'); 
        showToast('Neuer Artikel angelegt!');
        ladeAlles(); 
    } catch (e) { console.error(e); showToast("Fehler", "error"); }
}

async function neuenLagerortAnlegen() {
    const nOrt = prompt("Wie heißt der neue Lagerort?");
    if (!nOrt || nOrt.trim() === "") return;
    const { error } = await dbClient.from('lagerorte').insert([{ name: nOrt.trim() }]);
    if (error) showToast("Fehler: " + error.message, "error"); 
    else { showToast('Neuer Ort angelegt'); ladeAlles(); }
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

        const resPos = await dbClient.from('packlisten_positionen').select('*, artikel(id, name)');
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
            anzeigeName = pos.artikel.name;
            
            let gesamtLager = 0;
            let hatUnendlich = false;
            
            aktuelleDaten.forEach(b => { 
                if(b.artikel_id === pos.artikel_id) {
                    if(Number(b.menge) === -1) hatUnendlich = true;
                    gesamtLager += Number(b.menge); 
                }
            });
            
            if (hatUnendlich) {
                // Wenn Unendlich-Markierung, dann immer verfügbar
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
    // Sortiere Artikel im Dropdown alphabetisch
    const sortierteArt = [...alleArtikelInfos].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    sortierteArt.forEach(art => sel.add(new Option(art.name, art.id)));
    
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
    const menge = werteMengeAus(document.getElementById('pack-menge').value); // Auch hier Mathe erlauben
    
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
        ladeEventDaten(); 
    }
}

async function updatePackMenge(posId, neueMenge) {
    const calcMenge = werteMengeAus(neueMenge);
    await dbClient.from('packlisten_positionen').update({ menge: calcMenge }).eq('id', posId);
    showToast("Menge in Packliste aktualisiert");
    ladeEventDaten();
}

async function loeschePackPosition(posId) {
    if(confirm("Position von der Liste löschen?")) {
        await dbClient.from('packlisten_positionen').delete().eq('id', posId);
        ladeEventDaten();
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
        else { document.getElementById('packlisten-auswahl').value = ""; showToast("Gelöscht!"); ladeEventDaten(); }
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
            // Wenn der Artikel unendlich ist, brauchen wir ihn nicht auf der Einkaufsliste
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
    const menge = werteMengeAus(mengeFeld.value); // Mathe auch hier!

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
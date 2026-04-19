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

// --- AUTHENTIFIZIERUNG ---
document.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await dbClient.auth.getSession();
    if (session) { document.getElementById('login-overlay').style.display = 'none'; ladeAlles(); } 
    else { document.getElementById('login-overlay').style.display = 'flex'; }
});

dbClient.auth.onAuthStateChange(async (event, session) => {
    const overlay = document.getElementById('login-overlay');
    if (event === 'SIGNED_IN') { overlay.style.display = 'none'; ladeAlles(); } 
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
function openModal() { document.getElementById('artikelModal').style.display = 'block'; }

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
        if(selectNeu) { selectNeu.innerHTML = ''; data.forEach(o => selectNeu.add(new Option(o.name, o.id))); }
        if(selectEdit) { selectEdit.innerHTML = ''; data.forEach(o => selectEdit.add(new Option(o.name, o.id))); }
    }
}

async function ladeBestand() {
    const { data: alleArt } = await dbClient.from('artikel').select('*').order('name');
    alleArtikelInfos = alleArt || [];

    const { data, error } = await dbClient.from('bestand')
        .select(`id, menge, artikel_id, lagerort_id, artikel (id, name, gruppe, kategorie), lagerorte (id, name)`).order('id');
    
    if (error) { alert("Datenbank-Fehler beim Laden: " + error.message); return; }
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
    daten.forEach(z => { if (z.artikel && z.artikel.kategorie && z.artikel.kategorie.trim() !== '') kategorien.add(z.artikel.kategorie); });
    dropdown.innerHTML = '<option value="ALLE">Alle Kategorien</option>';
    Array.from(kategorien).sort().forEach(kat => dropdown.add(new Option(kat, kat)));
    if (Array.from(dropdown.options).some(o => o.value === aktuelleAuswahl)) dropdown.value = aktuelleAuswahl;
}

function wendeFilterAn() {
    const f = document.getElementById('kategorie-filter')?.value || 'ALLE';
    let gefilterteDaten = f !== 'ALLE' ? aktuelleDaten.filter(z => z.artikel && z.artikel.kategorie === f) : aktuelleDaten;
    tabelleAktualisieren(gefilterteDaten);
}

// --- NEUE INTELLIGENTE TABELLEN-LOGIK (Unterkategorien) ---
function tabelleAktualisieren(daten) {
    const tbody = document.getElementById('lager-tabelle');
    if (!tbody) return;
    tbody.innerHTML = ''; 
    const gruppierteDaten = {}; 
    const gruppenSummen = {}; 
    
    // 1. Alles in die Hauptgruppen (z.B. "Verpflegung") sortieren
    daten.forEach(zeile => {
        if (!zeile.artikel) return; 
        const gruppenName = zeile.artikel.gruppe || 'Weitere Artikel';
        gruppenSummen[gruppenName] = (gruppenSummen[gruppenName] || 0) + Number(zeile.menge);
        
        if (!gruppierteDaten[gruppenName]) { gruppierteDaten[gruppenName] = []; }
        gruppierteDaten[gruppenName].push(zeile); 
    });

    for (const [gruppenName, zeilenListe] of Object.entries(gruppierteDaten)) {
        // Haupt-Gruppen-Header (Grau)
        const headerTr = document.createElement('tr');
        headerTr.innerHTML = `
            <td colspan="3" style="background-color: #e2e8f0; color: #2c3e50; font-weight: bold; padding: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span>📁 ${gruppenName}</span>
                    <span class="summen-badge">Gesamt: ${gruppenSummen[gruppenName]}</span>
                </div>
            </td>
        `;
        tbody.appendChild(headerTr);

        // 2. Automatische Unterkategorien erkennen (1. Wort des Namens)
        const distinctNamesByPrefix = {};
        zeilenListe.forEach(z => {
            // Das erste Wort als möglichen Namen der Unterkategorie nehmen
            const prefix = z.artikel.name.trim().split(' ')[0];
            if(!distinctNamesByPrefix[prefix]) distinctNamesByPrefix[prefix] = new Set();
            distinctNamesByPrefix[prefix].add(z.artikel.name);
        });

        const subGroups = {};
        zeilenListe.forEach(z => {
            const prefix = z.artikel.name.trim().split(' ')[0];
            // Untergruppe NUR erstellen, wenn es mind. 2 verschiedene Artikel mit diesem ersten Wort gibt!
            let actualSubGroup = distinctNamesByPrefix[prefix].size > 1 ? prefix : 'OHNE_UNTERGRUPPE';

            if (!subGroups[actualSubGroup]) subGroups[actualSubGroup] = {};
            if (!subGroups[actualSubGroup][z.artikel.name]) subGroups[actualSubGroup][z.artikel.name] = [];
            subGroups[actualSubGroup][z.artikel.name].push(z);
        });

        // 3. Erst die "einzigartigen" Artikel OHNE Untergruppe rendern
        if (subGroups['OHNE_UNTERGRUPPE']) {
            renderArtikelRows(subGroups['OHNE_UNTERGRUPPE'], tbody, false);
        }

        // 4. Dann die automatisch erkannten Untergruppen rendern
        for (const [subName, artikelObjekt] of Object.entries(subGroups)) {
            if (subName === 'OHNE_UNTERGRUPPE') continue;

            const subTr = document.createElement('tr');
            subTr.innerHTML = `
                <td colspan="3" style="background-color: #f8f9fa; color: #2980b9; font-weight: bold; padding: 8px 12px 8px 25px; border-bottom: 1px solid #e2e8f0;">
                    📂 ${subName} <small style="color:#7f8c8d; font-weight:normal;">(Kollektion)</small>
                </td>
            `;
            tbody.appendChild(subTr);

            // True = Eingerückt rendern
            renderArtikelRows(artikelObjekt, tbody, true);
        }
    }
}

// Hilfsfunktion um die Zeilen zu zeichnen (mit oder ohne Einrückung)
function renderArtikelRows(artikelObjekt, tbody, isSubGroup) {
    for (const [artikelName, bestandsListe] of Object.entries(artikelObjekt)) {
        bestandsListe.forEach((zeile, index) => {
            const tr = document.createElement('tr');
            tr.className = "item-row"; 
            tr.style.cursor = isEditMode ? "pointer" : "default";
            
            tr.onclick = (event) => {
                if(event.target.tagName !== 'INPUT') { openEditModal(zeile.id); }
            };
            
            // Wenn in Unterkategorie, weiter einrücken und anderen Pfeil nutzen
            let paddingLeft = isSubGroup ? 45 : 15;
            let prefixIcon = isSubGroup ? '◦' : '↳';
            let nameZelle = index === 0 ? `<td style="padding-left:${paddingLeft}px; color: #333;">${prefixIcon} <strong>${artikelName}</strong></td>` : `<td></td>`; 
            
            tr.innerHTML = `
                ${nameZelle}
                <td style="color: #666;">📍 ${zeile.lagerorte.name}</td>
                <td><input type="number" id="menge-${zeile.id}" class="menge-input" value="${zeile.menge}" onchange="speichereMenge(${zeile.id})"></td>
            `;
            tbody.appendChild(tr);
        });
    }
}
// --- ENDE NEUE TABELLEN-LOGIK ---

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
    if(document.getElementById('edit-kategorie')) document.getElementById('edit-kategorie').value = z.artikel.kategorie || '';
    document.getElementById('edit-gruppe').value = z.artikel.gruppe || '';
    document.getElementById('edit-ort').value = z.lagerort_id;
    document.getElementById('edit-menge').value = z.menge;
    document.getElementById('editModal').style.display = 'block';
}

async function speichereBearbeitung() {
    try {
        const bId = document.getElementById('edit-bestand-id').value;
        const aId = document.getElementById('edit-artikel-id').value;
        const nName = document.getElementById('edit-name').value;
        const nKat = document.getElementById('edit-kategorie') ? document.getElementById('edit-kategorie').value : '';
        const nGrp = document.getElementById('edit-gruppe').value;
        const nOrt = document.getElementById('edit-ort').value;
        const nMenge = Number(document.getElementById('edit-menge').value);

        await dbClient.from('artikel').update({ name: nName, kategorie: nKat, gruppe: nGrp }).eq('id', aId);
        const { data: ex } = await dbClient.from('bestand').select('id, menge').eq('artikel_id', aId).eq('lagerort_id', nOrt).neq('id', bId).maybeSingle(); 
        if (ex) {
            await dbClient.from('bestand').update({ menge: Number(ex.menge) + nMenge }).eq('id', ex.id);
            await dbClient.from('bestand').delete().eq('id', bId);
        } else { await dbClient.from('bestand').update({ lagerort_id: nOrt, menge: nMenge }).eq('id', bId); }
        closeModal('editModal'); ladeAlles(); 
    } catch(e) { console.error("Fehler", e); }
}

async function artikelLoeschen() {
    if(confirm("Diesen Eintrag wirklich löschen?")) {
        await dbClient.from('bestand').delete().eq('id', document.getElementById('edit-bestand-id').value);
        closeModal('editModal'); ladeAlles();
    }
}

async function speichereMenge(bId) {
    const f = document.getElementById(`menge-${bId}`);
    if(f) f.style.backgroundColor = '#fff3cd'; 
    const { error } = await dbClient.from('bestand').update({ menge: f.value }).eq('id', bId);
    if (!error) {
        if(f) f.style.backgroundColor = '#d4edda'; 
        setTimeout(() => { if(f) f.style.backgroundColor = ''; ladeAlles(); }, 800); 
    }
}

async function artikelAnlegen() {
    try {
        const n = document.getElementById('new-name').value;
        const g = document.getElementById('new-gruppe').value;
        const o = document.getElementById('new-ort').value; 
        const m = document.getElementById('new-menge').value;
        const k = document.getElementById('new-kategorie') ? document.getElementById('new-kategorie').value : '';
        if (!n) { alert("Name fehlt!"); return; }

        const { data: nA, error: err } = await dbClient.from('artikel').insert([{ name: n, kategorie: k, gruppe: g }]).select();
        if (err) { alert("Fehler: " + err.message); return; }
        await dbClient.from('bestand').insert([{ artikel_id: nA[0].id, lagerort_id: o, menge: m }]);
        closeModal('artikelModal'); 
        document.getElementById('new-name').value = '';
        if(document.getElementById('new-kategorie')) document.getElementById('new-kategorie').value = '';
        document.getElementById('new-gruppe').value = '';
        ladeAlles(); 
    } catch (e) { console.error("Fehler", e); }
}

async function neuenLagerortAnlegen() {
    const nOrt = prompt("Wie heißt der neue Lagerort?");
    if (!nOrt || nOrt.trim() === "") return;
    const { error } = await dbClient.from('lagerorte').insert([{ name: nOrt.trim() }]);
    if (error) alert("Fehler: " + error.message); else ladeAlles();
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
        console.error("Fehler beim Event-Laden:", e);
    }
}

async function neuePacklisteAnlegen() {
    const nName = prompt("Name der neuen Packliste (z.B. Resort Wechselzone):");
    if (!nName || nName.trim() === "") return;
    const { error } = await dbClient.from('packlisten').insert([{ name: nName.trim() }]);
    if (error) alert("Fehler: " + error.message); else ladeEventDaten();
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
            aktuelleDaten.forEach(b => { if(b.artikel_id === pos.artikel_id) gesamtLager += Number(b.menge); });
            
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
        } else {
            anzeigeName = pos.eigener_name + " <small style='color:#999;'>(Eigener)</small>";
            statusHtml = `<span style="color:#7f8c8d;">- Manuell prüfen -</span>`;
        }

        let mengeZelle = pos.menge;
        if (isEventEditMode) {
            mengeZelle = `<input type="number" class="menge-input" value="${pos.menge}" onchange="updatePackMenge(${pos.id}, this.value)">`;
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
    if (!listId) { alert("Bitte wähle zuerst eine Packliste aus!"); return; }
    
    const sel = document.getElementById('pack-artikel-select');
    sel.innerHTML = '';
    alleArtikelInfos.forEach(art => sel.add(new Option(art.name, art.id)));
    
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
    aktuelleDaten.forEach(b => { if(b.artikel_id === selId) gesamtLager += Number(b.menge); });

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
    const menge = document.getElementById('pack-menge').value;
    
    let dbObj = { packliste_id: listId, menge: menge };

    if (typ === 'lager') {
        dbObj.artikel_id = document.getElementById('pack-artikel-select').value;
    } else {
        const en = document.getElementById('pack-eigener-name').value;
        if (!en) { alert("Bitte Namen eingeben!"); return; }
        dbObj.eigener_name = en;
    }

    const { error } = await dbClient.from('packlisten_positionen').insert([dbObj]);
    if (error) alert("Fehler: " + error.message);
    else { closeModal('packItemModal'); document.getElementById('pack-eigener-name').value=''; ladeEventDaten(); }
}

async function updatePackMenge(posId, neueMenge) {
    await dbClient.from('packlisten_positionen').update({ menge: neueMenge }).eq('id', posId);
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
    if (!listId) { alert("Bitte wähle zuerst eine Packliste aus."); return; }

    const aktuelleListe = packlisten.find(pl => pl.id == listId);
    const neuerName = prompt("Neuer Name für die Packliste:", aktuelleListe.name);

    if (!neuerName || neuerName.trim() === "" || neuerName === aktuelleListe.name) return;
    const { error } = await dbClient.from('packlisten').update({ name: neuerName.trim() }).eq('id', listId);
    if (error) alert("Fehler: " + error.message); else ladeEventDaten();
}

async function loeschePackliste() {
    const listId = document.getElementById('packlisten-auswahl').value;
    if (!listId) { alert("Bitte wähle zuerst eine Packliste aus."); return; }

    const aktuelleListe = packlisten.find(pl => pl.id == listId);
    if (confirm(`Möchtest du die Packliste "${aktuelleListe.name}" wirklich löschen?`)) {
        const { error } = await dbClient.from('packlisten').delete().eq('id', listId);
        if (error) alert("Fehler: " + error.message); else { document.getElementById('packlisten-auswahl').value = ""; ladeEventDaten(); }
    }
}

// ==========================================
// --- EINKAUFSLISTE UND EXCEL EXPORT ---
// ==========================================

function startEinkaufsliste() {
    einkaufslisteArray = []; 

    let artikelBestand = {};
    aktuelleDaten.forEach(b => {
        artikelBestand[b.artikel_id] = (artikelBestand[b.artikel_id] || 0) + Number(b.menge);
    });

    let artikelBedarf = {};
    let eigeneGegenstaende = {}; 

    packlistenPositionen.forEach(p => {
        if (p.artikel_id) {
            artikelBedarf[p.artikel_id] = (artikelBedarf[p.artikel_id] || 0) + Number(p.menge);
        } else if (p.eigener_name) {
            eigeneGegenstaende[p.eigener_name] = (eigeneGegenstaende[p.eigener_name] || 0) + Number(p.menge);
        }
    });

    const ulAuto = document.getElementById('auto-kauf-liste');
    ulAuto.innerHTML = '';

    alleArtikelInfos.forEach(art => {
        let bestand = artikelBestand[art.id] || 0;
        let bedarf = artikelBedarf[art.id] || 0;
        
        if (bedarf > bestand) {
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
    const menge = Number(mengeFeld.value);

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
        alert("Die Liste ist komplett leer. Es gibt nichts zum Herunterladen.");
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
        cell.border = {
            bottom: { style: 'medium', color: { argb: 'FF000000' } } 
        };
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
}
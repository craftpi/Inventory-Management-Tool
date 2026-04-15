// 1. Supabase konfigurieren
const SUPABASE_URL = 'https://frrfjpnrewwlgfqtgjqg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZycmZqcG5yZXd3bGdmcXRnanFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTIyMDEsImV4cCI6MjA5MTgyODIwMX0.kfAyIBbO314WDzQHXzTlPFXpPQ92Ez_mgYbTY2TqxU4';

const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Globale Variablen
let aktuelleDaten = [];
let isEditMode = false;

// --- AUTHENTIFIZIERUNG (Kugelsicher) ---
console.log("App gestartet. Prüfe Login-Status...");

dbClient.auth.onAuthStateChange((event, session) => {
    console.log("Supabase meldet:", event, "| Eingeloggt:", !!session);
    
    const overlay = document.getElementById('login-overlay');
    
    if (session) {
        if (overlay) overlay.style.display = 'none';
        // Wenn eingeloggt, starte den Datenabruf
        ladeAlles();
    } else {
        if (overlay) overlay.style.display = 'flex';
        const loginButton = document.querySelector('#login-overlay button');
        if (loginButton) loginButton.innerText = "🔓 Entsperren";
    }
});

async function handleLogin() {
    const versteckteEmail = 'lager@trisported.de'; 
    const password = document.getElementById('login-password').value;
    const errorMsg = document.getElementById('login-error');
    const loginButton = document.querySelector('#login-overlay button');
    
    if(loginButton) loginButton.innerText = "Prüfe...";

    const { error } = await dbClient.auth.signInWithPassword({
        email: versteckteEmail,
        password: password,
    });

    if (error) {
        if(errorMsg) errorMsg.style.display = 'block';
        if(loginButton) loginButton.innerText = "🔓 Entsperren";
        console.error("Login-Fehler:", error.message);
    } else {
        if(errorMsg) errorMsg.style.display = 'none';
        document.getElementById('login-password').value = ''; 
    }
}

async function handleLogout() {
    console.log("Melde ab...");
    await dbClient.auth.signOut();
}

// --- DATEN LADEN ---
async function ladeAlles() {
    try {
        console.log("Schritt 1: Lade Lagerorte (Dropdowns)...");
        await ladeLagerorte();
        
        console.log("Schritt 2: Lade Lagerbestand...");
        await ladeBestand();
        
        console.log("Erfolg: Alles fertig geladen!");
    } catch (fehler) {
        console.error("FEHLER BEIM LADEN:", fehler);
    }
}

async function ladeLagerorte() {
    const { data, error } = await dbClient.from('lagerorte').select('*');
    if (error) { console.error("Fehler bei Lagerorten:", error); return; }
    
    if (data) {
        const selectNeu = document.getElementById('new-ort');
        const selectEdit = document.getElementById('edit-ort');
        
        // Verhindert Absturz, falls die Dropdowns im HTML fehlen
        if(selectNeu) { selectNeu.innerHTML = ''; data.forEach(o => selectNeu.add(new Option(o.name, o.id))); }
        if(selectEdit) { selectEdit.innerHTML = ''; data.forEach(o => selectEdit.add(new Option(o.name, o.id))); }
    }
}

async function ladeBestand() {
    const { data, error } = await dbClient
        .from('bestand')
        .select(`id, menge, artikel_id, lagerort_id, artikel (id, name, gruppe), lagerorte (id, name)`)
        .order('id', { ascending: true });

    if (error) { console.error('Fehler bei Bestand:', error); return; }

    aktuelleDaten = data || []; 
    tabelleAktualisieren(aktuelleDaten);
}

// --- TABELLE AUFBAUEN ---
function tabelleAktualisieren(daten) {
    const tbody = document.getElementById('lager-tabelle');
    if (!tbody) { console.error("FEHLER: Finde <tbody id='lager-tabelle'> nicht im HTML!"); return; }
    
    tbody.innerHTML = ''; 
    const gruppierteDaten = {};
    const gruppenSummen = {}; 
    
    daten.forEach(zeile => {
        // Sicherheits-Check, falls ein Artikel keinen Namen hat
        if (!zeile.artikel) return; 

        const gruppenName = zeile.artikel.gruppe || 'Weitere Artikel';
        const artikelName = zeile.artikel.name;
        
        gruppenSummen[gruppenName] = (gruppenSummen[gruppenName] || 0) + Number(zeile.menge);
        if (!gruppierteDaten[gruppenName]) { gruppierteDaten[gruppenName] = {}; }
        if (!gruppierteDaten[gruppenName][artikelName]) { gruppierteDaten[gruppenName][artikelName] = []; }
        gruppierteDaten[gruppenName][artikelName].push(zeile); 
    });

    for (const [gruppenName, artikelObjekt] of Object.entries(gruppierteDaten)) {
        const headerTr = document.createElement('tr');
        headerTr.innerHTML = `
            <td colspan="3" style="background-color: #e2e8f0; color: #2c3e50; font-weight: bold; padding: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span>📁 ${gruppenName}</span>
                    <span class="summen-badge" style="font-size:0.85em; background:#3498db; color:white; padding:4px 10px; border-radius:12px;">Gesamt: ${gruppenSummen[gruppenName]}</span>
                </div>
            </td>
        `;
        tbody.appendChild(headerTr);

        for (const [artikelName, bestandsListe] of Object.entries(artikelObjekt)) {
            bestandsListe.forEach((zeile, index) => {
                const tr = document.createElement('tr');
                tr.className = "item-row"; 
                tr.style.cursor = isEditMode ? "pointer" : "default";
                
                tr.onclick = (event) => {
                    if(event.target.tagName !== 'INPUT') { openEditModal(zeile.id); }
                };
                
                let artikelZelle = index === 0 ? `<td style="padding-left: 25px; color: #333;">↳ <strong>${artikelName}</strong></td>` : `<td></td>`; 
                tr.innerHTML = `
                    ${artikelZelle}
                    <td style="color: #666;">📍 ${zeile.lagerorte.name}</td>
                    <td><input type="number" id="menge-${zeile.id}" class="menge-input" value="${zeile.menge}" onchange="speichereMenge(${zeile.id})" style="width:60px; text-align:center;"></td>
                `;
                tbody.appendChild(tr);
            });
        }
    }
}

// --- BEARBEITUNGS-MODUS ---
function toggleEditMode() {
    isEditMode = !isEditMode;
    const btn = document.getElementById('btn-edit-mode');
    
    if (isEditMode) {
        if(btn) { btn.innerText = "✏️ Bearbeiten: AN"; btn.style.backgroundColor = "#e67e22"; }
        ladeBestand(); // Lädt neu, um die Mauszeiger (Pointer) anzupassen
    } else {
        if(btn) { btn.innerText = "✏️ Bearbeiten: AUS"; btn.style.backgroundColor = "#f39c12"; }
        ladeBestand();
    }
}

function openEditModal(bestandId) {
    if (!isEditMode) return; 
    const zeile = aktuelleDaten.find(z => z.id === bestandId);
    if (!zeile) return;

    // Versuche Felder zu füllen. Wenn eines fehlt, gibt es keinen harten Absturz mehr.
    try {
        document.getElementById('edit-bestand-id').value = zeile.id;
        document.getElementById('edit-artikel-id').value = zeile.artikel_id;
        document.getElementById('edit-name').value = zeile.artikel.name;
        document.getElementById('edit-gruppe').value = zeile.artikel.gruppe || '';
        document.getElementById('edit-ort').value = zeile.lagerort_id;
        document.getElementById('edit-menge').value = zeile.menge;
        document.getElementById('editModal').style.display = 'block';
    } catch (e) {
        console.error("FEHLER: HTML für Bearbeiten-Fenster fehlt oder ist fehlerhaft!", e);
        alert("Das Bearbeitungsfenster konnte nicht geöffnet werden. Fehlt HTML-Code?");
    }
}

function closeEditModal() { 
    const modal = document.getElementById('editModal');
    if(modal) modal.style.display = 'none'; 
}

async function speichereBearbeitung() {
    try {
        const bId = document.getElementById('edit-bestand-id').value;
        const aId = document.getElementById('edit-artikel-id').value;
        const neuerName = document.getElementById('edit-name').value;
        const neueGruppe = document.getElementById('edit-gruppe').value;
        const neuerOrt = document.getElementById('edit-ort').value;
        const neueMenge = document.getElementById('edit-menge').value;

        await dbClient.from('artikel').update({ name: neuerName, gruppe: neueGruppe }).eq('id', aId);
        await dbClient.from('bestand').update({ lagerort_id: neuerOrt, menge: neueMenge }).eq('id', bId);

        closeEditModal();
        ladeAlles(); 
    } catch(e) { console.error("Fehler beim Speichern der Bearbeitung:", e); }
}

async function artikelLoeschen() {
    if(confirm("Eintrag löschen?")) {
        const bId = document.getElementById('edit-bestand-id').value;
        await dbClient.from('bestand').delete().eq('id', bId);
        closeEditModal();
        ladeAlles();
    }
}

// --- MENGE SPEICHERN ---
async function speichereMenge(bestandId) {
    const inputFeld = document.getElementById(`menge-${bestandId}`);
    if(inputFeld) inputFeld.style.backgroundColor = '#fff3cd'; 
    
    const { error } = await dbClient.from('bestand').update({ menge: inputFeld.value }).eq('id', bestandId);
    
    if (error) { 
        if(inputFeld) inputFeld.style.backgroundColor = '#f8d7da'; 
    } else {
        if(inputFeld) inputFeld.style.backgroundColor = '#d4edda'; 
        setTimeout(() => { if(inputFeld) inputFeld.style.backgroundColor = ''; ladeAlles(); }, 800); 
    }
}

// --- NEUER ARTIKEL ---
function openModal() { 
    const modal = document.getElementById('artikelModal');
    if(modal) modal.style.display = 'block'; 
}
function closeModal() { 
    const modal = document.getElementById('artikelModal');
    if(modal) modal.style.display = 'none'; 
}

async function artikelAnlegen() {
    try {
        const name = document.getElementById('new-name').value;
        const gruppe = document.getElementById('new-gruppe').value;
        const ortId = document.getElementById('new-ort').value; 
        const menge = document.getElementById('new-menge').value;

        if (!name) { alert("Bitte Name angeben!"); return; }

        const { data: neuArt, error: artErr } = await dbClient.from('artikel').insert([{ name: name, gruppe: gruppe }]).select();
        
        if (!artErr) {
            await dbClient.from('bestand').insert([{ artikel_id: neuArt[0].id, lagerort_id: ortId, menge: menge }]);
            closeModal(); 
            document.getElementById('new-name').value = '';
            document.getElementById('new-gruppe').value = '';
            ladeAlles(); 
        }
    } catch (e) {
        console.error("Fehler beim Anlegen:", e);
    }
}
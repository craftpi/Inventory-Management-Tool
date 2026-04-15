// 1. Supabase konfigurieren
const SUPABASE_URL = 'https://frrfjpnrewwlgfqtgjqg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZycmZqcG5yZXd3bGdmcXRnanFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTIyMDEsImV4cCI6MjA5MTgyODIwMX0.kfAyIBbO314WDzQHXzTlPFXpPQ92Ez_mgYbTY2TqxU4';

const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- GLOBALE VARIABLEN ---
let aktuelleDaten = [];
let isEditMode = false;

// --- AUTHENTIFIZIERUNG ---
dbClient.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN') {
        document.getElementById('login-overlay').style.display = 'none';
        await ladeLagerorte(); // NEU: Lädt zuerst die Dropdowns
        ladeBestand();         // Dann die Tabelle laden
    } else if (event === 'SIGNED_OUT') {
        document.getElementById('login-overlay').style.display = 'flex';
    }
});

async function handleLogin() {
    const versteckteEmail = 'lager@trisported.de'; 
    const password = document.getElementById('login-password').value;
    const errorMsg = document.getElementById('login-error');
    const loginButton = document.querySelector('#login-overlay button');
    
    loginButton.innerText = "Prüfe...";

    const { error } = await dbClient.auth.signInWithPassword({
        email: versteckteEmail,
        password: password,
    });

    if (error) {
        errorMsg.style.display = 'block';
        loginButton.innerText = "🔓 Entsperren";
        console.error("Login-Fehler:", error.message);
    } else {
        errorMsg.style.display = 'none';
    }
}

async function handleLogout() {
    const { error } = await dbClient.auth.signOut();
    if (error) console.error("Fehler beim Abmelden:", error.message);
}

// --- LAGERORTE FÜR DROPDOWNS LADEN ---
async function ladeLagerorte() {
    const { data, error } = await dbClient.from('lagerorte').select('*');
    if (data) {
        const selectNeu = document.getElementById('new-ort');
        const selectEdit = document.getElementById('edit-ort');
        if(selectNeu && selectEdit) {
            selectNeu.innerHTML = ''; selectEdit.innerHTML = '';
            data.forEach(ort => {
                selectNeu.add(new Option(ort.name, ort.id));
                selectEdit.add(new Option(ort.name, ort.id));
            });
        }
    }
}

// --- DATEN LADEN ---
async function ladeBestand() {
    const { data, error } = await dbClient
        .from('bestand')
        .select(`
            id, menge, artikel_id, lagerort_id,
            artikel (id, name, gruppe), 
            lagerorte (id, name)
        `)
        .order('id', { ascending: true });

    if (error) {
        console.error('Fehler beim Laden:', error);
        return;
    }

    aktuelleDaten = data; // Zwischenspeichern für den Edit-Modus
    tabelleAktualisieren(data);
}

// --- TABELLE AUFBAUEN & SUMMEN BERECHNEN ---
function tabelleAktualisieren(daten) {
    const tbody = document.getElementById('lager-tabelle');
    tbody.innerHTML = ''; 

    const gruppierteDaten = {};
    const gruppenSummen = {}; // NEU: Zähler für die Gesamtmengen
    
    daten.forEach(zeile => {
        const gruppenName = zeile.artikel.gruppe || 'Weitere Artikel';
        const artikelName = zeile.artikel.name;
        
        // Summe für diese Gruppe hochzählen
        gruppenSummen[gruppenName] = (gruppenSummen[gruppenName] || 0) + Number(zeile.menge);
        
        if (!gruppierteDaten[gruppenName]) { gruppierteDaten[gruppenName] = {}; }
        if (!gruppierteDaten[gruppenName][artikelName]) { gruppierteDaten[gruppenName][artikelName] = []; }
        
        gruppierteDaten[gruppenName][artikelName].push(zeile); 
    });

    for (const [gruppenName, artikelObjekt] of Object.entries(gruppierteDaten)) {
        
        // Gruppen-Überschrift (Mit Gesamtmenge)
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

        for (const [artikelName, bestandsListe] of Object.entries(artikelObjekt)) {
            bestandsListe.forEach((zeile, index) => {
                const tr = document.createElement('tr');
                tr.className = "item-row"; 
                
                // Klick auf die Zeile öffnet das Bearbeiten-Fenster (falls aktiv)
                tr.onclick = (event) => {
                    if(event.target.tagName !== 'INPUT') { openEditModal(zeile.id); }
                };
                
                let artikelZelle = index === 0 ? `<td style="padding-left: 25px; color: #333;">↳ <strong>${artikelName}</strong></td>` : `<td></td>`; 

                tr.innerHTML = `
                    ${artikelZelle}
                    <td style="color: #666;">📍 ${zeile.lagerorte.name}</td>
                    <td>
                        <input type="number" 
                               id="menge-${zeile.id}" 
                               class="menge-input" 
                               value="${zeile.menge}"
                               onchange="speichereMenge(${zeile.id})">
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    }
}

// --- BEARBEITUNGS-MODUS STEUERUNG ---
function toggleEditMode() {
    isEditMode = !isEditMode;
    const btn = document.getElementById('btn-edit-mode');
    const tbody = document.getElementById('lager-tabelle');
    
    if (isEditMode) {
        btn.innerText = "✏️ Bearbeiten: AN";
        btn.style.backgroundColor = "#e67e22";
        tbody.classList.add('edit-active');
    } else {
        btn.innerText = "✏️ Bearbeiten: AUS";
        btn.style.backgroundColor = "#f39c12";
        tbody.classList.remove('edit-active');
    }
}

function openEditModal(bestandId) {
    if (!isEditMode) return; 
    
    const zeile = aktuelleDaten.find(z => z.id === bestandId);
    if (!zeile) return;

    document.getElementById('edit-bestand-id').value = zeile.id;
    document.getElementById('edit-artikel-id').value = zeile.artikel_id;
    document.getElementById('edit-name').value = zeile.artikel.name;
    document.getElementById('edit-gruppe').value = zeile.artikel.gruppe || '';
    document.getElementById('edit-ort').value = zeile.lagerort_id;
    document.getElementById('edit-menge').value = zeile.menge;

    document.getElementById('editModal').style.display = 'block';
}

function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }

async function speichereBearbeitung() {
    const bId = document.getElementById('edit-bestand-id').value;
    const aId = document.getElementById('edit-artikel-id').value;
    const neuerName = document.getElementById('edit-name').value;
    const neueGruppe = document.getElementById('edit-gruppe').value;
    const neuerOrt = document.getElementById('edit-ort').value;
    const neueMenge = document.getElementById('edit-menge').value;

    // Artikel und Bestand updaten
    await dbClient.from('artikel').update({ name: neuerName, gruppe: neueGruppe }).eq('id', aId);
    await dbClient.from('bestand').update({ lagerort_id: neuerOrt, menge: neueMenge }).eq('id', bId);

    closeEditModal();
    ladeBestand(); 
}

async function artikelLoeschen() {
    if(confirm("Möchtest du diesen Eintrag wirklich komplett löschen?")) {
        const bId = document.getElementById('edit-bestand-id').value;
        await dbClient.from('bestand').delete().eq('id', bId);
        closeEditModal();
        ladeBestand();
    }
}

// --- SCHNELLES SPEICHERN (Menge) ---
async function speichereMenge(bestandId) {
    const inputFeld = document.getElementById(`menge-${bestandId}`);
    inputFeld.style.backgroundColor = '#fff3cd'; 
    
    const { error } = await dbClient.from('bestand').update({ menge: inputFeld.value }).eq('id', bestandId);
    
    if (error) { 
        inputFeld.style.backgroundColor = '#f8d7da'; 
    } else {
        inputFeld.style.backgroundColor = '#d4edda'; 
        setTimeout(() => { 
            inputFeld.style.backgroundColor = ''; 
            ladeBestand(); // Lädt neu, um die Gruppen-Summe oben zu aktualisieren
        }, 800); 
    }
}

// --- MODAL STEUERUNG FÜR "NEUER ARTIKEL" ---
function openModal() { document.getElementById('artikelModal').style.display = 'block'; }
function closeModal() { document.getElementById('artikelModal').style.display = 'none'; }

async function artikelAnlegen() {
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
        ladeBestand(); 
    } else {
        console.error(artErr);
    }
}
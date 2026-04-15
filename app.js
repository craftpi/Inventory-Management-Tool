// Am Anfang der app.js hinzufügen
// Prüfen, ob User bereits eingeloggt ist
dbClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN') {
        document.getElementById('login-overlay').style.display = 'none';
        ladeBestand(); // Erst jetzt Daten laden
    } else if (event === 'SIGNED_OUT') {
        document.getElementById('login-overlay').style.display = 'flex';
    }
});

async function handleLogin() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const errorMsg = document.getElementById('login-error');

    const { error } = await dbClient.auth.signInWithPassword({
        email: email,
        password: password,
    });

    if (error) {
        errorMsg.style.display = 'block';
        console.error(error.message);
    } else {
        errorMsg.style.display = 'none';
    }
}

// Optional: Logout Funktion
async function handleLogout() {
    await dbClient.auth.signOut();
}
// 1. Supabase konfigurieren
const SUPABASE_URL = 'https://frrfjpnrewwlgfqtgjqg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZycmZqcG5yZXd3bGdmcXRnanFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTIyMDEsImV4cCI6MjA5MTgyODIwMX0.kfAyIBbO314WDzQHXzTlPFXpPQ92Ez_mgYbTY2TqxU4';

const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 2. Daten laden (Jetzt mit der neuen Spalte 'gruppe')
async function ladeBestand() {
    const { data, error } = await dbClient
        .from('bestand')
        .select(`
            id,
            menge,
            artikel (name, gruppe), 
            lagerorte (name)
        `)
        .order('id', { ascending: true });

    if (error) {
        console.error('Fehler beim Laden:', error);
        return;
    }

    tabelleAktualisieren(data);
}

// 3. Daten doppelt gruppieren und in die HTML-Tabelle schreiben
function tabelleAktualisieren(daten) {
    const tbody = document.getElementById('lager-tabelle');
    tbody.innerHTML = ''; // Tabelle leeren

    // --- NEU: Verschachteltes Sortieren (Gruppe -> Artikel) ---
    const gruppierteDaten = {};
    
    daten.forEach(zeile => {
        const gruppenName = zeile.artikel.gruppe || 'Weitere Artikel';
        const artikelName = zeile.artikel.name;
        
        // 1. Ebene: Gruppe anlegen, falls nicht existent
        if (!gruppierteDaten[gruppenName]) {
            gruppierteDaten[gruppenName] = {}; 
        }
        
        // 2. Ebene: Artikel in der Gruppe anlegen, falls nicht existent
        if (!gruppierteDaten[gruppenName][artikelName]) {
            gruppierteDaten[gruppenName][artikelName] = [];
        }

        // Den spezifischen Bestand (Lagerort + Menge) zum Artikel hinzufügen
        gruppierteDaten[gruppenName][artikelName].push(zeile); 
    });

    // --- NEU: Tabelle aufbauen ---
    for (const [gruppenName, artikelObjekt] of Object.entries(gruppierteDaten)) {
        
        // A) Die Gruppen-Überschrift (Ordner)
        const headerTr = document.createElement('tr');
        headerTr.innerHTML = `
            <td colspan="3" style="background-color: #e2e8f0; color: #2c3e50; font-weight: bold; padding-top: 15px; font-size: 1.1em;">
                📁 ${gruppenName}
            </td>
        `;
        tbody.appendChild(headerTr);

        // B) ...dann gehen wir alle Artikel in dieser Gruppe durch
        for (const [artikelName, bestandsListe] of Object.entries(artikelObjekt)) {
            
            // C) ...und listen alle Orte auf, wo dieser Artikel liegt
            bestandsListe.forEach((zeile, index) => {
                const tr = document.createElement('tr');
                
                let artikelZelle = '';
                // Nur beim ERSTEN Ort schreiben wir den Namen des Artikels hin
                if (index === 0) {
                    artikelZelle = `<td style="padding-left: 25px; color: #333;">↳ <strong>${artikelName}</strong></td>`;
                } else {
                    // Bei weiteren Orten lassen wir die Zelle einfach leer
                    artikelZelle = `<td></td>`; 
                }

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
// 4. Neue Menge in der Datenbank speichern (Bleibt unverändert)
async function speichereMenge(bestandId) {
    const inputFeld = document.getElementById(`menge-${bestandId}`);
    const neueMenge = inputFeld.value;

    inputFeld.style.backgroundColor = '#fff3cd'; 

    const { error } = await dbClient
        .from('bestand')
        .update({ menge: neueMenge })
        .eq('id', bestandId);

    if (error) {
        console.error('Fehler beim Speichern:', error);
        inputFeld.style.backgroundColor = '#f8d7da'; 
    } else {
        inputFeld.style.backgroundColor = '#d4edda'; 
        setTimeout(() => { inputFeld.style.backgroundColor = ''; }, 1000);
    }
}

document.addEventListener('DOMContentLoaded', ladeBestand);

// Modal Steuerung
function openModal() {
    document.getElementById('artikelModal').style.display = 'block';
}

function closeModal() {
    document.getElementById('artikelModal').style.display = 'none';
    // Felder leeren
    document.getElementById('new-name').value = '';
    document.getElementById('new-gruppe').value = '';
}

// Neuen Artikel in die DB schreiben
async function artikelAnlegen() {
    const name = document.getElementById('new-name').value;
    const gruppe = document.getElementById('new-gruppe').value;
    const ortId = document.getElementById('new-ort').value;
    const menge = document.getElementById('new-menge').value;

    if (!name || !ortId) {
        alert("Bitte Name und Lagerort-ID angeben!");
        return;
    }

    // SCHRITT 1: Artikel erstellen
    const { data: neuArt, error: artErr } = await dbClient
        .from('artikel')
        .insert([{ name: name, gruppe: gruppe }])
        .select();

    if (artErr) {
        console.error(artErr);
        return;
    }

    // SCHRITT 2: Bestand verknüpfen (mit der ID des gerade erstellten Artikels)
    const { error: bestErr } = await dbClient
        .from('bestand')
        .insert([{ 
            artikel_id: neuArt[0].id, 
            lagerort_id: ortId, 
            menge: menge 
        }]);

    if (bestErr) {
        console.error(bestErr);
    } else {
        closeModal();
        ladeBestand(); // Tabelle neu laden, um den neuen Artikel zu sehen
    }
}
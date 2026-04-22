const SUPABASE_URL = 'https://frrfjpnrewwlgfqtgjqg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZycmZqcG5yZXd3bGdmcXRnanFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTIyMDEsImV4cCI6MjA5MTgyODIwMX0.kfAyIBbO314WDzQHXzTlPFXpPQ92Ez_mgYbTY2TqxU4';
const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

function werteMengeAus(eingabe) {
    if (eingabe === undefined || eingabe === null) return 0;
    const saubererString = String(eingabe).replace(/[^0-9+\-*/().]/g, '');
    if (saubererString === '') return 0;
    try {
        const ergebnis = new Function('return ' + saubererString)();
        return Math.round(ergebnis); 
    } catch (e) { return 0; }
}

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

function openRechtliches(event, modalId) {
    event.preventDefault();
    document.getElementById(modalId).style.display = 'block';
}

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
    document.getElementById('new-einheit').value = 'Stück';
    
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
    
    const firstBtnInf = firstRow.querySelector('.btn-inf');
    firstBtnInf.style.background = '#95a5a6';
    firstBtnInf.setAttribute('data-active', 'false'); 

    const firstBtnStrich = firstRow.querySelector('.btn-strich');
    if(firstBtnStrich) {
        firstBtnStrich.style.background = '#95a5a6';
        firstBtnStrich.setAttribute('data-active', 'false');
    }

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
    
    const btnInf = newRow.querySelector('.btn-inf');
    btnInf.style.background = '#95a5a6';
    btnInf.setAttribute('data-active', 'false'); 

    const btnStrich = newRow.querySelector('.btn-strich');
    if(btnStrich) {
        btnStrich.style.background = '#95a5a6';
        btnStrich.setAttribute('data-active', 'false');
    }

    const newSelect = newRow.querySelector('.new-ort');
    const defaultOrt = alleLagerorte.find(o => o.name.toLowerCase() === 'sonstiger ort im lager');
    if (defaultOrt && newSelect) {
        newSelect.value = defaultOrt.id;
    }

    const btnAddDelete = newRow.lastElementChild;
    btnAddDelete.innerHTML = '🗑️';
    btnAddDelete.style.backgroundColor = '#e74c3c';
    btnAddDelete.title = "Ort entfernen";
    btnAddDelete.onclick = function() { newRow.remove(); };

    container.appendChild(newRow);
}

async function ladeAlles() {
    await ladeLagerorte();
    
    const { data: listData } = await dbClient.from('packlisten').select('*');
    packlisten = listData || [];

    const resPos = await dbClient.from('packlisten_positionen').select('*, artikel(id, name, kategorie, einheit)');
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
        .select(`id, menge, alte_menge, created_at, artikel_id, lagerort_id, artikel (id, name, kategorie, einheit), lagerorte (id, name)`).order('id');
    
    if (error) {
        console.warn("Spalte created_at fehlt in Supabase. Lade ohne Datum.");
        const fallback = await dbClient.from('bestand')
            .select(`id, menge, alte_menge, artikel_id, lagerort_id, artikel (id, name, kategorie, einheit), lagerorte (id, name)`).order('id');
        data = fallback.data;
        if (fallback.error) { showToast("Datenbank-Fehler", "error"); return; }
    }

    aktuelleDaten = data || []; 
    aktualisiereFilterDropdown(aktuelleDaten); 
    wendeFilterAn(); 
}

function aktualisiereFilterDropdown(daten) {
    const dropdown = document.getElementById('kategorie-filter');
    const datalist = document.getElementById('kategorie-liste');
    
    const kategorien = new Set();
    daten.forEach(z => { 
        if (z.artikel && z.artikel.kategorie && z.artikel.kategorie.trim() !== '') {
            kategorien.add(z.artikel.kategorie.trim()); 
        }
    });

    if (dropdown) {
        const aktuelleAuswahl = dropdown.value;
        dropdown.innerHTML = '<option value="ALLE">Alle Kategorien</option>';
        Array.from(kategorien).sort().forEach(kat => dropdown.add(new Option(kat, kat)));
        if (Array.from(dropdown.options).some(opt => opt.value === aktuelleAuswahl)) dropdown.value = aktuelleAuswahl;
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
    const ortFilter = document.getElementById('lagerort-filter')?.value || 'ALLE';
    const suchText = document.getElementById('such-filter')?.value.toLowerCase().trim() || '';
    
    let gefilterteDaten = aktuelleDaten;

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
                    <span>${icon} ${katName}</span>
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

        artikelGruppen.forEach((gruppe, artId) => {
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
                            <span>🏷️ ${prefix}</span>
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

            let bestandInfoHtml = "";
            const einheit = gruppe.artikel.einheit || 'Stück';

            gruppe.bestaende.forEach(b => {
                const isInfLocal = (Number(b.menge) === -1);
                const isStrichLocal = (Number(b.menge) === -2);
                let mengeZelle = "";
                
                if (isInfLocal) {
                    mengeZelle = `<span style="font-size: 1.2em; color: #7f8c8d; font-weight: bold;" title="Verbrauchsartikel (Unendlich)">∞</span> <small style="color: #888; font-size: 0.8em; margin-left: 3px;">${einheit}</small>`;
                } else if (isStrichLocal) {
                    mengeZelle = `<span style="font-size: 1.4em; color: #7f8c8d; font-weight: bold;" title="Ohne Wert / Nicht zutreffend">-</span>`;
                } else {
                    mengeZelle = `
                        <div style="display: flex; align-items: center; gap: 5px; justify-content: flex-end;">
                            <input type="text" id="menge-${b.id}" class="menge-input" value="${b.menge}" onchange="speichereMenge(${b.id})" style="width: 60px;">
                            <small style="color: #888; font-size: 0.8em; width: 45px; text-align: left;">${einheit}</small>
                        </div>`;
                }

                bestandInfoHtml += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid #f0f0f0; padding-bottom: 4px;">
                        <span style="font-size: 0.9em; color: #666;">📍 ${b.lagerorte.name}</span>
                        ${mengeZelle}
                    </div>`;
            });

            tr.innerHTML = `
                <td class="no-select" style="padding-left: ${indent}px; color:#333; vertical-align: top;"
                    data-hover-type="date" data-hover-content="${dateStr}"
                    onmouseenter="handleMouseEnter(event)" onmouseleave="handleMouseLeave(event)"
                    ontouchstart="handleTouchStart(event)" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)">
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

function toggleRowInfinite(btn) {
    const input = btn.parentElement.querySelector('input');
    const strichBtn = btn.parentElement.querySelector('.btn-strich');
    const isInfinite = btn.getAttribute('data-active') === 'true';

    if (isInfinite) {
        input.disabled = false;
        input.value = input.getAttribute('data-old-value') || '0';
        btn.style.background = '#95a5a6';
        btn.setAttribute('data-active', 'false');
    } else {
        if (input.value !== '∞' && input.value !== '-') input.setAttribute('data-old-value', input.value);
        input.value = '∞';
        input.disabled = true;
        btn.style.background = '#27ae60';
        btn.setAttribute('data-active', 'true');
        
        if(strichBtn && strichBtn.getAttribute('data-active') === 'true') toggleRowStrich(strichBtn);
    }
}

function toggleRowStrich(btn) {
    const input = btn.parentElement.querySelector('input');
    const infBtn = btn.parentElement.querySelector('.btn-inf');
    const isStrich = btn.getAttribute('data-active') === 'true';

    if (isStrich) {
        input.disabled = false;
        input.value = input.getAttribute('data-old-value') || '0';
        btn.style.background = '#95a5a6';
        btn.setAttribute('data-active', 'false');
    } else {
        if (input.value !== '∞' && input.value !== '-') input.setAttribute('data-old-value', input.value);
        input.value = '-';
        input.disabled = true;
        btn.style.background = '#7f8c8d' ;
        btn.setAttribute('data-active', 'true');
        
        if(infBtn && infBtn.getAttribute('data-active') === 'true') toggleRowInfinite(infBtn);
    }
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
        return `<option value="${o.id}" ${isSelected ? 'selected' : ''}>${o.name}</option>`;
    }).join('');
    
    let displayVal = '0';
    let hiddenOldVal = '0'; 
    
    if (data) {
        if (data.menge == -1) displayVal = '∞';
        else if (data.menge == -2) displayVal = '-';
        else displayVal = data.menge;
        
        hiddenOldVal = data.alte_menge !== undefined && data.alte_menge !== null ? data.alte_menge : (data.menge < 0 ? '0' : data.menge);
    }

    const isInf = (displayVal === '∞');
    const isStrich = (displayVal === '-');
    const btnColorInf = isInf ? '#27ae60' : '#95a5a6'; 
    const btnColorStrich = isStrich ? '#7f8c8d' : '#95a5a6'; 

    div.innerHTML = `
        <select class="edit-ort-select" style="flex: 2; padding: 10px; border-radius: 6px; border: 1px solid #ccc;">${options}</select>
        
        <div style="flex: 1; display: flex; gap: 4px;">
            <input type="text" class="edit-menge-input" value="${displayVal}" data-old-value="${hiddenOldVal}" style="width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #ccc; text-align: center;" ${(isInf || isStrich) ? 'disabled' : ''}>
            <button type="button" class="btn btn-inf" style="background: ${btnColorInf}; padding: 8px 12px; width: auto; min-width: 40px; font-weight: bold;" title="Unendlich umschalten" data-active="${isInf}" onclick="toggleRowInfinite(this)">∞</button>
            <button type="button" class="btn btn-strich" style="background: ${btnColorStrich}; padding: 8px 12px; width: auto; min-width: 40px; font-weight: bold;" title="Ohne Bestand umschalten" data-active="${isStrich}" onclick="toggleRowStrich(this)">-</button>
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
    document.getElementById('edit-einheit').value = art.einheit || 'Stück';

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

        const doppelt = alleArtikelInfos.find(a => a.name.toLowerCase() === nName.toLowerCase() && String(a.id) !== String(aid));
        if (doppelt) {
            const weiter = confirm(`Hinweis: Ein anderer Artikel heißt bereits "${nName}" (Kategorie: ${doppelt.kategorie || 'Ohne'}). Wirklich umbenennen?`);
            if (!weiter) return;
        }

        await dbClient.from('artikel').update({ name: nName, kategorie: nKat, einheit: nEinheit }).eq('id', aid);
        await dbClient.from('bestand').delete().eq('artikel_id', aid);

        const inserts = [];
        document.querySelectorAll('.edit-ort-row').forEach(row => {
            const oid = row.querySelector('.edit-ort-select').value;
            const input = row.querySelector('.edit-menge-input');
            const mRaw = input.value;
            
            const alteMengeAusFeld = werteMengeAus(input.getAttribute('data-old-value') || '0');
            const menge = (mRaw === '∞') ? -1 : (mRaw === '-') ? -2 : werteMengeAus(mRaw);
            
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
        
        if (!n) { showToast("Bitte einen Namen eingeben!", "warning"); return; }

        const existiertBereits = alleArtikelInfos.find(a => a.name.toLowerCase() === n.toLowerCase());
        if (existiertBereits) {
            const weiter = confirm(`Warnung: Ein Artikel mit dem Namen "${n}" existiert bereits in der Kategorie "${existiertBereits.kategorie || 'Ohne Kategorie'}". Möchtest du ihn trotzdem anlegen?`);
            if (!weiter) return;
        }

        const { data: nA, error: err } = await dbClient.from('artikel').insert([{ name: n, kategorie: k, einheit: e }]).select();
        if (err) { showToast("Fehler: " + err.message, "error"); return; }
        
        const bestandInserts = [];
        const rows = document.querySelectorAll('#new-orte-wrapper .lagerort-row');
        
        rows.forEach(row => {
            const ortSelect = row.querySelector('.new-ort').value;
            const input = row.querySelector('.new-menge');
            const mRaw = input.value;
            
            const alteMengeAusFeld = werteMengeAus(input.getAttribute('data-old-value') || '0');
            const menge = (mRaw === '∞') ? -1 : (mRaw === '-') ? -2 : werteMengeAus(mRaw);
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
            
            aktuelleDaten.forEach(b => { 
                if(b.artikel_id === pos.artikel_id) {
                    if(Number(b.menge) === -1) hatUnendlich = true;
                    else if(Number(b.menge) >= 0) gesamtLager += Number(b.menge); 
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
    aktuelleDaten.forEach(b => { 
        if(b.artikel_id === selId) {
            if(Number(b.menge) === -1) hatUnendlich = true;
            else if(Number(b.menge) >= 0) gesamtLager += Number(b.menge); 
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

    let artikelBestand = {};
    let artikelUnendlich = new Set();
    
    aktuelleDaten.forEach(b => {
        if (Number(b.menge) === -1) {
            artikelUnendlich.add(b.artikel_id);
        } else if (Number(b.menge) >= 0) {
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

    const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf("/") + 1);

    const printWindow = window.open('', '_blank');
    
    let html = `
        <html>
        <head>
            <title>Packliste: ${liste.name}</title>
            <style>
                body { font-family: sans-serif; padding: 20px; color: #333; }
                .header-container { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e3000f; padding-bottom: 15px; margin-bottom: 20px; }
                .header-text h1 { color: #e3000f; margin: 0 0 5px 0; }
                .header-text p { margin: 0; color: #666; }
                .corner-logo { height: 60px; width: auto; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
                th { background-color: #f2f2f2; }
                .check { width: 30px; border: 1px solid #333; height: 20px; display: inline-block; }
                @media print { .no-print { display: none; } tr { page-break-inside: avoid; } }
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
            <div style="margin-top: 30px; font-size: 0.8em; color: #666; text-align: center;">Trisport Erding Lager-Verwaltung</div>
        </body>
        </html>`;

    printWindow.document.write(html);
    printWindow.document.close();
}
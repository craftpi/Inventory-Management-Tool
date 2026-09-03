# Inventory Management Tool

Eine einfache und übersichtliche Anwendung zur Verwaltung von Beständen, Artikeln, Lagerbewegungen und Lieferanten. Das Tool eignet sich für kleine bis mittlere Unternehmen, Werkstätten, Lager, Shops oder private Bestandsverwaltung, die ihre Materialien und Produkte effizient kontrollieren möchten.

## Inhaltsverzeichnis

- [Überblick](#überblick)
- [Funktionen](#funktionen)
- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Erste Einrichtung](#erste-einrichtung)
- [Benutzung](#benutzung)
  - [Artikel verwalten](#artikel-verwalten)
  - [Bestände kontrollieren](#bestände-kontrollieren)
  - [Eingänge und Ausgänge erfassen](#eingänge-und-ausgänge-erfassen)
  - [Lieferanten verwalten](#lieferanten-verwalten)
  - [Berichte und Auswertungen](#berichte-und-auswertungen)
- [Benutzeroberfläche](#benutzeroberfläche)
- [Konfiguration](#konfiguration)
- [Sicherheits- und Datenschutzaspekte](#sicherheits-und-datenschutzaspekte)
- [Fehlerbehebung](#fehlerbehebung)
- [Tipps für den produktiven Einsatz](#tipps-für-den-produktiven-einsatz)
- [Roadmap](#roadmap)
- [Lizenz](#lizenz)
- [Kontakt](#kontakt)

## Überblick

Das Inventory Management Tool hilft dabei, alle relevanten Informationen rund um den Warenbestand zentral zu erfassen und zu verwalten. Es vereinfacht die tägliche Arbeit mit:

- Inventarverwaltung von Produkten bzw. Materialien
- Lagerbestand pro Standort oder Lagerplatz
- Ein- und Ausgang von Waren
- Lieferanten- und Bestellinformationen
- Sichtbarkeit von kritischen Beständen
- Überblick über Verfügbarkeit, Restbestand und Bestellstatus

Das System ist besonders nützlich, wenn Bestände manuell gepflegt werden und dadurch Fehler, Überbestände oder Fehlbestände entstehen. Durch eine klare Struktur und schnelle Eingaben lässt sich der Lagerbestand besser planen und kontrollieren.

## Funktionen

Das Tool bietet typischerweise die folgenden Funktionen:

- Artikel anlegen, bearbeiten und archivieren
- Lagerplätze oder Standorte verwalten
- Bestandsmenge pro Artikel erfassen
- Einkauf, Umlagerung und Verkauf/Ausgang verfolgen
- Warnungen bei niedrigem Bestand oder kritischen Mengen
- Lieferanten- und Bestellhistorie pflegen
- Filterung nach Kategorien, Lager, Lieferant oder Status
- Suche nach Artikeln, Seriennummern oder Codes
- Such-, Sortier- und Exportfunktionen
- Berichte über aktuelle Bestände und Bewegungen

## Voraussetzungen

Volle NFC funktions unterstützung ist aktuel nur auf android gegeben.

## Installation

1. Repository oder Projektordner herunterladen.
2. Das Projekt in einen lokalen Ordner entpacken oder klonen.
3. Abhängigkeiten installieren:

   - Bei Java/Maven:
     ```bash
     mvn install
     ```

   - Bei .NET:
     ```bash
     dotnet restore
     ```

   - Bei Node.js:
     ```bash
     npm install
     ```

4. Falls eine Datenbank erforderlich ist, die passende Datenbank erstellen und konfigurieren.
5. Die Konfigurationsdatei anpassen, sofern nötig.
6. Die Anwendung starten.

Beispiel für das Starten einer Anwendung:

```bash
java -jar inventory-management-tool.jar
```

oder

```bash
dotnet run
```

oder

```bash
npm start
```

## Erste Einrichtung

Nach dem ersten Start solltest du folgende Schritte durchführen:

1. Datenbankverbindung prüfen
2. Grunddaten anlegen:
   - Lager
   - Kategorien
   - Lieferanten
   - Benutzer
3. erste Artikel erfassen
4. Standardwerte definieren, z. B. Mindestbestand
5. Sicherheits- oder Zugriffsrechte festlegen

### Empfohlene Basisdaten

- Lagerstandorte: Hauptlager, Nebenlager, Versandlager
- Artikelkategorien: Elektronik, Werkzeuge, Bürobedarf, Ersatzteile
- Lieferanten: Hersteller, Großhändler, lokale Händler
- Mindestbestandsregeln: z. B. 10 Stück pro Artikel

## Benutzung

### Artikel verwalten

Artikel sind das Herzstück des Tools. Jeder Artikel sollte mindestens folgende Informationen besitzen:

- Artikelnummer
- Bezeichnung
- Kategorie
- Einheit (z. B. Stück, Kiste, Paket)
- Lieferant
- Preis / Einkaufspreis
- Mindestbestand
- Lagerort
- Seriennummer oder eindeutiger Code (falls relevant)

So legst du einen neuen Artikel an:

1. Menüpunkt „Artikel“ oder „Inventar“ öffnen
2. „Neu“ oder „Artikel hinzufügen“ wählen
3. Pflichtfelder ausfüllen
4. Lagerort und Mindestbestand festlegen
5. Speichern

Artikel lassen sich später bearbeiten, löschen oder archivieren. Über die Suchfunktion lassen sich Einträge schnell auffinden.

### Bestände kontrollieren

Der Bestand zeigt den aktuellen Stand eines Artikels an. In der Bestandsansicht können folgende Informationen sichtbar sein:

- Verfügbar
- Reserviert
- Bestellt
- Durchschnittsverbrauch
- Mindestbestand
- Lagerort

Mögliche Aktionen:

- Bestand manuell korrigieren
- Inventur durchführen
- Bestände nach Lager filtern
- Statusfarbe für kritische Mengen anzeigen

### Eingänge und Ausgänge erfassen

Das Tool sollte möglichst jede Bewegung nachvollziehbar erfassen. Typische Bewegungen sind:

- Wareneingang
- Warenausgang
- Umbuchung zwischen Lagern
- Rücksendung
- Verlust / Schaden
- Inventurkorrektur

Jede Bewegung sollte dokumentiert werden mit:

- Datum und Uhrzeit
- Artikel
- Menge
- Lagerort
- Vorgangstyp
- Hinweis / Kommentar
- Verantwortlicher Benutzer

Beispiel: Wenn 25 Stück eines Artikels geliefert werden, wird ein Wareneingang mit +25 erfasst. Beim Verkauf oder Verbrauch wird ein Warenausgang mit -25 erfasst.

### Lieferanten verwalten

Lieferanten sind wichtig, um Bestellungen und Verfügbarkeiten zu verfolgen. Typische Lieferanteninformationen:

- Name
- Kontaktperson
- E-Mail
- Telefon
- Adresse
- Lieferbedingungen
- Lieferzeiten

Der Lieferantenbereich kann genutzt werden, um:

- Bestellhistorie zu sehen
- Lieferzeiten zu vergleichen
- veraltete oder inaktive Lieferanten zu markieren
- Produktzuordnungen zu verwalten

### Berichte und Auswertungen

Ein gutes Inventory-Tool sollte Auswertungen ermöglichen, damit Entscheidungen schneller getroffen werden können. Mögliche Berichte:

- Aktueller Lagerbestand
- Artikel mit niedrigem Bestand
- Bestandsveränderungen über einen Zeitraum
- Lieferantenübersicht
- Inventurberichte
- Umsatz-/Verbrauchsanalysen

Berichte können je nach Implementierung als Tabelle, PDF, CSV oder Bildschirmansicht exportiert werden.

## Benutzeroberfläche

Die Oberfläche ist in der Regel in Bereiche unterteilt:

- Navigationsleiste
- Dashboard mit Kennzahlen
- Artikelverwaltung
- Lagerverwaltung
- Lieferantenverwaltung
- Bewegungs-/Bestandslog
- Berichte
- Einstellungen

Ein typisches Dashboard zeigt z. B. folgende Kennzahlen an:

- Gesamtanzahl Artikel
- Gesamtbestand nach Menge
- Artikel mit kritischem Bestand
- Wareneingänge dieser Woche
- Warenausgänge dieser Woche
- aktive Lieferanten

## Konfiguration

Je nach Technologie können Einstellungen in einer Konfigurationsdatei oder über die Oberfläche angepasst werden.

Typische Konfigurationsparameter:

- Datenbankverbindung
- Standard-Lager
- Währung
- Sprache
- Benachrichtigungsgrenzen
- Speicherpfad für Dateien oder Backups
- Login- und Sicherheitsoptionen

Beispiel für eine typische Konfigurationsdatei:

```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "name": "inventory_db",
    "user": "admin"
  },
  "currency": "EUR",
  "warningThreshold": 10,
  "defaultWarehouse": "Hauptlager"
}
```

## Sicherheits- und Datenschutzaspekte

Wenn das Tool im Unternehmen eingesetzt wird, sollten folgende Punkte beachtet werden:

- Benutzerrechte und Rollen verwalten
- Zugriff auf sensible Daten begrenzen
- Passwörter sicher speichern
- regelmäßige Backups erstellen
- Datenbankzugang nur mit minimalen Rechten erlauben
- Zugriff auf die Anwendung per HTTPS absichern
- Logdateien für Änderungen pflegen

## Fehlerbehebung

### Problem: Anwendung startet nicht

Mögliche Ursachen:

- fehlende Laufzeitumgebung
- fehlerhafte Konfiguration
- fehlerhafte Datenbankverbindung
- fehlende Abhängigkeiten

Lösung:

- Laufzeitumgebung prüfen
- Abhängigkeiten neu installieren
- Konfigurationsdateien überprüfen
- Logs ansehen

### Problem: Artikel werden nicht korrekt gespeichert

Prüfe:

- Pflichtfelder
- Datenbankverbindung
- Dateisystem-Berechtigungen
- Validierungsregeln

### Problem: Bestände stimmen nicht

Prüfe:

- Bewegungslog auf Fehler oder doppelte Einträge
- Inventurkorrekturen
- manuelle Bestandseingaben
- Lieferanten-/Wareneingangsdatensätze

### Problem: Login oder Rechte funktionieren nicht

Prüfe:

- Benutzerkonto vorhanden
- Passwort korrekt
- Rolle oder Rechte korrekt zugewiesen
- Server- oder Auth-Konfiguration

## Tipps für den produktiven Einsatz

- Standardisierte Artikelnamen und Nummern verwenden
- Mindestbestände regelmäßig überprüfen und anpassen
- Jede Lagerbewegung dokumentieren und nachvollziehbar machen
- Inventuren regelmäßig durchführen
- Benachrichtigungen für kritische Bestände aktivieren
- Backups automatisieren
- nur autorisierte Personen Zugriff auf Bestandsdaten geben
- Reporting nutzen, um Engpässe frühzeitig zu erkennen

## Roadmap

Zukünftige Verbesserungen könnten sein:

- Scanfunktion für Barcode-/QR-Codes
- Mobile App für Lagerarbeiter
- API für Drittanwendungen
- Automatische Bestellvorschläge
- erweiterte Analyse- und Dashboard-Funktionen
- Multi-Standort-Management
- Import/Export für Excel und CSV

## Lizenz

Dieses Projekt steht unter der entsprechenden Lizenz des Repositorys. Bitte prüfe die Lizenzdatei im Projektordner, bevor du das Tool in einem produktiven Umfeld einsetzt.

## Kontakt

Bei Fragen, Feedback oder Erweiterungswünschen kannst du dich an den Projektverantwortlichen wenden oder über das Repository eine Anfrage stellen.

---

## Kurzfassung

Das Inventory Management Tool ist eine zentrale Lösung zur Verwaltung von Artikeln, Beständen und Lagerbewegungen. Es hilft, Bestandsfehler zu vermeiden, Lieferungen effizient zu verfolgen und jederzeit einen Überblick über die Verfügbarkeit von Waren zu behalten. Die Anwendung ist besonders geeignet für kleine Unternehmen, Werkstätten, Lager und organisationsübergreifende Bestandsprozesse.

Wenn du möchtest, kann ich dir als Nächstes auch noch eine:

- Version mit konkreten Screenshots-Abschnitten und Beispiel-UI-Beschreibungen erstellen
- Version mit detaillierten Installationsschritten für dein konkretes Stack (Java, .NET, Python, Node.js)
- Version als kürzere Unternehmens-README mit Fokus auf Produkt- und Betriebsdokumentation erstellen

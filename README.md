# Media Agentcy

WhatsApp-KI-Assistent für die Nutzer deines Jellyfin-/Plex-Servers.

- **Medienwünsche**: Nutzer schreiben "kannst du Dune 2 besorgen?" → Suche über Jellyseerr/Ombi, Anfrage im Namen des Nutzers
- **Benachrichtigungen**: Sobald eine Anfrage verfügbar ist, bekommt der Nutzer eine persönliche WhatsApp
- **Problemmeldungen**: Ticket anlegen → Diagnose (Radarr/Sonarr/Jellyfin/Plex) → kleine Medienfehler selbst beheben (Datei ersetzen, fehlende Folgen suchen, Rescan, Metadaten) → Nutzer informieren, sobald die neue Datei da ist
- **Eskalation**: Größere Probleme gehen per WhatsApp an dich (Admin). Du redest im selben Chat mit dem Agenten darüber, und er richtet den Nutzern Antworten aus.
- **Gedächtnis pro Nutzer**: Fakten (Geräte, Vorlieben, …) + laufende Zusammenfassung früherer Gespräche + Ticket-/Anfrageverlauf
- **KI-Anbieter frei wählbar**: OpenRouter, OpenAI, ChatGPT-Login (experimentell) oder jeder OpenAI-kompatible Endpoint (Ollama, LM Studio, LiteLLM …)

## Ablauf

```
WhatsApp (Baileys) ──► Router ──► Agent (LLM + Tools) ──► Jellyfin · Plex · Jellyseerr · Ombi · Sonarr · Radarr
   ▲                    │  ├─ Zugangskontrolle (neue Nummern → Admin)      │
   │                    │  ├─ bündelt Nachrichten, 1 Warteschlange/Nutzer   ▼
   │                    │  └─ Nutzer-Agent  |  Admin-Agent           SQLite: Nutzer, Gedächtnis, Tickets,
   └──── Antworten ◄────┘                                            Anfragen, Auto-Fix-Watches
Poller (alle 5 min): fertige Anfragen + Auto-Fix-Ergebnisse → Benachrichtigung
```

**Nutzer-Agent** darf nur für sich selbst handeln: suchen, anfragen (Tageslimit), Tickets anlegen, diagnostizieren, `fix_media` (Ersetzen höchstens einmal pro Ticket und mit Tageslimit), eskalieren, eigenes Gedächtnis pflegen.

**Admin-Agent** (deine Nummer) hat zusätzlich: Nutzer freischalten/sperren/verknüpfen, Tickets verwalten/lösen, Nutzern Nachrichten ausrichten, Broadcast, System-Health, Aktivitätsprotokoll, Gedächtnis aller Nutzer.

## Setup

### 1. Konfiguration
```bash
cp .env.example .env
```
Mindestens setzen: `ADMIN_NUMBERS`, `LLM_PROVIDER`/`LLM_API_KEY`/`LLM_MODEL` und die Dienste, die du nutzt.
API-Keys findest du hier:
- Jellyfin: Dashboard → API-Schlüssel
- Jellyseerr/Overseerr: Einstellungen → Allgemein → API-Schlüssel
- Sonarr/Radarr: Settings → General → API Key
- Plex: [X-Plex-Token finden](https://support.plex.tv/articles/204059436)
- Ombi: Einstellungen → Ombi → API-Key

### 2. Lokal testen (ohne WhatsApp)
```bash
npm install
npm run chat
```
Du chattest als Testnutzer. Mit `/as admin` wechselst du in den Admin-Chat, `/as 49151…` wechselt zu einem anderen Nutzer, `/poll` stößt die Benachrichtigungsprüfung an. Tipp: `DATA_DIR=./data-dev` in einer eigenen Shell setzen, damit Test-Daten getrennt bleiben.

### 3. Auf Unraid deployen
```bash
docker compose up -d --build
```
Auf Unraid: Projektordner z. B. nach `/mnt/user/appdata/media-agentcy-src` kopieren, Volume auf `/mnt/user/appdata/media-agentcy` zeigen lassen und per *Compose Manager*-Plugin starten.

### 4. WhatsApp verbinden
Nutze am besten eine **eigene Nummer** für den Bot (Zweit-SIM/eSIM, WhatsApp Business App geht auch).
- Öffne `http://<unraid-ip>:8085/qr` (mit `?token=…` falls `HTTP_TOKEN` gesetzt), oder schau in die Container-Logs.
- Auf dem Bot-Handy: WhatsApp → Verknüpfte Geräte → Gerät hinzufügen → QR scannen.
- Der Login bleibt in `/data/whatsapp-auth` gespeichert.

### 5. Loslegen
1. Schreib dem Bot von deiner Admin-Nummer "Hi". Du wirst automatisch als Admin angelegt.
2. Ein Nutzer schreibt dem Bot → du bekommst "🆕 Neue Nummer …".
3. Antworte z. B.: *"Schalte #2 frei, das ist Max, Jellyfin-User max"*. Der Agent schaltet frei, verknüpft das Jellyfin- und Jellyseerr-Konto und begrüßt Max.

Verknüpfte Konten sind wichtig: Anfragen laufen dann im Namen des Nutzers (`X-Api-User`), Anfragen von der Jellyseerr-Webseite werden ebenfalls benachrichtigt, und die Wiedergabe-Diagnose sieht die Sessions des Nutzers.

### Optional: Jellyseerr-Webhook
Jellyseerr → Einstellungen → Benachrichtigungen → Webhook → URL `http://<bot>:8085/webhook/seerr?token=…`, Ereignis "Medien verfügbar". Dann kommt die Benachrichtigung sofort statt erst beim nächsten Poll.

## Beispiele im Admin-Chat
- "Was ist mit Ticket 4?" / "Welche Tickets sind offen?"
- "Sag Max, dass ich das am Wochenende fixe"
- "Ticket 4 ist erledigt, Festplatte war voll"
- "Wie gesund ist das System?"
- "Was weißt du über Lisa?" / "Merk dir bei Lisa: nutzt einen Fire TV Stick"
- "Schick allen: Heute 22 Uhr Wartung, ca. 30 min"

Befehle (ohne KI): `/hilfe`, `/reset` (Verlauf leeren), `/status` (Admin: Dienste prüfen).

## Sicherheit und Grenzen
- Nutzer-Agent und Admin-Agent sind getrennt. Was ein Agent darf, hängt an der Absendernummer, nicht am Text der Nachricht. Prompt-Injection von Nutzern bekommt deshalb keinen Zugriff auf Admin-Tools.
- `replace_file` löscht die aktuelle Datei, bevor neu gesucht wird. Das ist abschaltbar (`AUTOFIX_REPLACE_FILE=false`), läuft höchstens einmal pro Ticket und unterliegt einem Tageslimit. Findet sich nach 72 h nichts, geht es automatisch an dich.
- Baileys ist eine **inoffizielle** WhatsApp-Bibliothek. Der Bot verschickt nur Antworten und Benachrichtigungen, mit Abstand zwischen den Nachrichten. Für Massen-Broadcasts ist er nicht gedacht.
- **ChatGPT-Login** nutzt die interne Codex-Schnittstelle von OpenAI. Sie ist nicht offiziell und kann sich jederzeit ändern.
- Gegen echte Server noch nicht getestet: Ombi-Anbindung (deren API ist uneinheitlich), Plex-Details, ChatGPT-Provider. Die automatischen Tests decken Jellyseerr, Radarr und Jellyfin mit einem Fake-Server ab.

## Entwicklung
```bash
npm run dev        # Bot mit Auto-Reload
npm test           # End-to-End-Test mit gescriptetem LLM und Fake-Media-Stack
npm run typecheck
```

Struktur:
```
src/
  agent/        Agent-Schleife, Prompts, Nutzer- & Admin-Tools
  db/           SQLite-Schema (node:sqlite) + Repository
  integrations/ Jellyfin, Plex, Jellyseerr/Overseerr, Ombi, Sonarr, Radarr
  llm/          OpenAI-kompatibel (OpenRouter/OpenAI/custom) + ChatGPT/Codex
  messaging/    Router: Onboarding, Zugriff, Debounce, Warteschlangen
  notifier/     Poller: fertige Anfragen, Auto-Fix-Follow-up
  whatsapp/     Baileys-Client (QR-Login, LID→Telefonnummer, Bilder)
  server/       /health, /qr, /webhook/seerr
  cli/          lokaler Test-Chat
```

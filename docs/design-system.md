# Buddy Island · Design-System «Nachtinsel»

Entstanden mit Anthropics offiziellem Skill **frontend-design** (unverändert installiert unter `.claude/skills/frontend-design/`, Quelle `anthropics/claude-plugins-official`, `plugins/frontend-design`, Version 1.1.1).

Die Werte stehen nur in `src/renderer/css/tokens.css`. Alle anderen Dateien benutzen Variablen. Eine lebende Übersicht aller Komponenten zeigt `docs/styleguide.html` (im Browser öffnen, `?theme=light` für hell).

## Gegenstand

Buddy ist ein kleiner Begleiter, der im oberen Bildschirmrand wohnt: eine schwarze Pille mit zwei Augen, die sich zu einer Arbeitsfläche öffnet. Er ist für Leute gebaut, die am Windows-PC schnell etwas erledigen wollen. Seine Aufgabe ist, schnell zu antworten oder zu handeln und dann wieder aus dem Weg zu gehen.

## Richtung

1. **Ein Objekt.** Das Island ist offen wie geschlossen echtes Schwarz (`#000`), kein eingefärbtes Fast-Schwarz. Es öffnet sich, statt ein Fenster zu zeigen. Inhalte stehen direkt darauf.
2. **Listen statt Karten.** Gruppen haben eine Linie oben und unten und Haarlinien dazwischen, keine Box.
   - **Gefüllt (Graphit):** nur was man bearbeitet oder kopiert, also Eingabe, Code, die eigene Nachricht, Chips und Knöpfe.
   - **Gerahmt:** nur Entscheidungen (Freigabe-Dialog).
3. **Das Auge ist das Motiv.** Die Kapselform von Buddys Augen markiert Zustände:

   | Ort | Darstellung |
   |---|---|
   | Aktiver Tab, gewähltes Segment | geschlossenes Auge darunter |
   | Planschritt offen | Auge zu (grau) |
   | Planschritt jetzt dran | Auge offen (Lagune) |
   | Planschritt fertig | Seegras |
   | Planschritt fehlgeschlagen | Koralle |
   | Tippen | zwei Augen, die schauen |
   | Statuspunkte, Meldungen | senkrechte Kapsel |
   | Schalter an (dunkles Theme) | dunkles «Auge» auf heller Lagune |

4. **Ein Signal.** Lagune (`#8EE0D2`, entsättigt) gehört den Augen, dem Fokus und dem, was gerade aktiv ist. Alles andere bleibt Nebel auf Schwarz.
5. **Bewegung antwortet.** Es gibt eine orchestrierte Folge beim Öffnen:
   - Der Rahmen wächst, die Augen reiten auf der Kante nach links.
   - Danach erscheint der Inhalt, zuletzt der Titel, wenn die Augen angekommen sind.
   - Einblende-Animationen für jede Nachricht, Meldung oder jeden Chip gibt es nicht.

**Abgeglichen mit den typischen KI-Mustern im Skill:**

| Muster im Skill | Umgang hier |
|---|---|
| Karten-Baukasten | ersetzt durch Listen |
| Fast-Schwarz `#111` | ersetzt durch echtes Schwarz |
| Neon-Akzent | Lagune entsättigt und begrenzt auf Augen, Fokus, Aktives |
| Mono für Datenlabels | Mono nur für Code und Protokolle |
| Grossbuchstaben-Labels | keine |
| Radius überall gleich | Radien nach Rang |

## Farben

| Name | Dunkel | Hell («Tag») | Rolle |
|---|---|---|---|
| Tinte | `#000000` | `#F7F8F7` (Papier) | Fläche des Islands |
| Graphit | `#161618` | `#ECEEED` | Bedienflächen |
| Nebel | `#E9ECEB` | `#121816` | Text |
| Lagune | `#8EE0D2` | `#0B6F64` (abgeleitet) | Augen, Fokus, aktiv |
| Koralle | `#FF7A6B` | `#CF3E30` | Fehler, Gefahr |
| Bernstein | `#F2C14E` | `#B07208` | Warnung |
| Seegras | `#5ED39A` | `#1D8A55` | Erfolg |

Text-Abstufungen: `--text-1` bis `--text-4`. Gedämpfter Text (`--text-3`) hat auf allen Flächen mindestens 4.5:1.

Die Akzentfarbe ist wählbar. `app.js` leitet daraus ab:
- `--accent-text` mit mindestens 4.5:1
- `--accent-fill`
- `--on-accent`
- `--accent-on-ink` für die Augen
- `--knob-on` für den Schalter

So bleibt jede Farbe in beiden Themes lesbar. Das geschlossene Island ist immer schwarz.

## Schrift

Dieselben Schriften wie auf der Website: **Bricolage Grotesque** für Überschriften (Display, Bereich, Titel, Abschnitte; OFL, liegt in `src/renderer/fonts/`), **Segoe UI Variable** für Text und Bedienelemente (in Windows eingebaut), **Cascadia Mono** für Code und Protokolle.

Skala nach Bringhurst:

| Token | Grösse/Zeile | Gewicht | Wofür |
|---|---|---|---|
| `--type-display` | 27/30 | 700 | «Hoi, ich bin Buddy.» als die eine grosse Zeile |
| `--type-h1` | 20/24 | 650 | Bereich |
| `--type-h2` | 16/20 | 650 | Island-Titel, Dialog |
| `--type-h3` | 13.5/16 | 650 | Abschnitt |
| `--type-body` | 14/20 | 400 | Fliesstext (Antworten 21 px Zeile, max. 68 Zeichen) |
| `--type-body-2` | 13/18 | 400 | Listen |
| `--type-label` | 13/16 | 560 | Knöpfe, Tabs |
| `--type-caption` | 12/16 | 400 | Fussnoten (max. 62 Zeichen) |
| `--type-meta` | 11/14 | 400 | Metadaten |

## Raster und Formen

- **Abstände:** 4er-Raster (`--space-1` bis `--space-8`: 4 bis 40).
- **Ränder:** 20 px im offenen Island (`--view-x`). Inhalt und Augen stehen auf derselben linken Kante. Listen haben keinen eigenen Innenrand.
- **Höhen:** Listenzeilen mindestens 44 px, Bedienelemente 28 und 36 px, Icon-Knopf 32 px.
- **Radien nach Rang:**

  | Element | Radius |
  |---|---|
  | Island offen | 34 |
  | Code, Dialog, eigene Nachricht | 14 |
  | Eingabezeile | 20 |
  | Knöpfe, Felder | 10 |
  | Inline-Code | 6 |
  | Augenkapsel | 3 |
  | Chips, Badges, Schalter | Pille |

- **Tiefe:** Im Dunkeln keine Schatten. Im Hellen eine feine Kante und ein weicher Schatten nur um das offene Island.

## Dateien

| Datei | Inhalt |
|---|---|
| `css/tokens.css` | Schriften, Farben (dunkel/hell), Typo, Abstände, Masse, Radien, Tiefe, Bewegung, Island-Masse |
| `css/base.css` | Grundregeln, Fokus, Icons, Scrollbalken, reduzierte Bewegung |
| `css/components.css` | jede Komponente genau einmal mit allen Zuständen |
| `css/island.css` | das Island: Zustände, Auf-/Zuklappen, Höhenregeln |
| `css/views.css` | Anordnung der Ansichten |

## Zustände

| Zustand | Darstellung |
|---|---|
| Hover | Text oder Fläche eine Stufe heller |
| Aktiv | leicht eingedrückt |
| Fokus | Lagune-Ring, nur per Tastatur |
| Deaktiviert | 40 % |
| Laden | `aria-busy="true"` mit Spinner |
| Fehler | `aria-invalid="true"` bzw. Koralle |
| Gewählt | Auge, `.on` oder `:checked` |

**Island:**

| `data-state` | Darstellung |
|---|---|
| `idle` | Augen zu |
| `busy`, `control` | Augen schauen |
| `done` | ^ ^ |
| `error` | flache, korallenrote Augen |
| `timer`, `alarm` | runde Augen mit Linie |
| `listen` | hohe Augen und Aufnahmepunkt |
| `music` | Cover und Pegel aus der Mitte |
| `peek` | Mitteilung |
| `notch` | minimiert |

## Regeln für neuen Code

1. Keine Farbe, Grösse, Rundung oder Dauer als Zahl ausserhalb von `tokens.css`.
2. Keine neue Box: zuerst Liste, dann Feld. Ein Rahmen nur für eine Entscheidung.
3. Lagune nur für Augen, Fokus und Aktives. Status über Koralle, Bernstein und Seegras.
4. Bewegung nur als Antwort auf eine Handlung und nur mit transform oder opacity.
5. Texte aus Sicht der Nutzerin, in Satzschreibung, Fehler sagen, was zu tun ist.

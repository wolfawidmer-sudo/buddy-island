# Buddy Island · Design-System «Lagune»

Ein Satz Regeln für die ganze Oberfläche. Die Werte stehen nur in `src/renderer/css/tokens.css`. Alle anderen Dateien benutzen Variablen. Eine lebende Übersicht aller Komponenten und Zustände zeigt `docs/styleguide.html` (im Browser öffnen, `?theme=light` für hell).

## Grundidee

- **Tinte statt Schwarz.** Offene Flächen sind tiefes, leicht kühles Graphit (`--bg #111215`). Nur das geschlossene Island ist reines Schwarz, wie ein Stück Hardware, auch im hellen Theme.
- **Ein Signal.** Die Akzentfarbe gehört Buddys Augen, dem Fokus und dem, was gerade aktiv ist. Status hat eigene, ruhige Farben: Erfolg, Warnung, Gefahr.
- **Konzentrische Radien.** Innen = aussen minus Abstand: Island 32 → Karte 16 → Bedienelement 10 → Inline 6.
- **Tiefe über Flächentöne.** Im Dunkeln keine Schatten. Im Hellen nur feine Konturen und ein einziger weicher Schatten um das offene Island.
- **Keine Deko.** Kein Glas, keine Unschärfe, keine Verläufe auf Flächen, keine Endlos-Animation im Leerlauf.

## Dateien und Reihenfolge

| Datei | Inhalt |
|---|---|
| `css/tokens.css` | Farben (dunkel/hell), Schrift, Abstände, Masse, Radien, Tiefe, Bewegung, Island-Masse |
| `css/base.css` | Grundregeln: Schrift, Fokus, Auswahl, Icons, Scrollbalken, reduzierte Bewegung |
| `css/components.css` | Jede Komponente genau einmal (ältere Klassennamen als Aliase) |
| `css/island.css` | Das Island: Rahmen, Kopf, alle Zustände, Auf-/Zuklappen, Höhenregeln |
| `css/views.css` | Anordnung der Ansichten: Chat, Karten, Einstellungen, Nutzung, lokale KI |

## Tokens (Auszug)

**Farben:** `--bg`, `--surface-1/2/3`, `--fill-1/2/3`, `--separator`, `--border`, `--text-1` bis `--text-4`, `--success/warning/danger` (+ `-text`, `-soft`), `--focus-ring`.
Kontrast (WCAG): `--text-1` ≥ 13:1, `--text-2` ≥ 6:1, `--text-3` ≥ 4.5:1 auf allen Flächen. `--text-4` nur für Platzhalter und Deaktiviertes.

**Akzent:** Standard ist «Lagune» `#4CC9B8`, wählbar in den Einstellungen. `app.js` leitet daraus Varianten ab:
- `--accent-text`: als Text auf der Fläche, mind. 4.5:1
- `--accent-fill`: als Knopf oder Schalter
- `--on-accent`: Schwarz oder Weiss, je nachdem, was besser lesbar ist
- `--accent-on-ink`: Augen auf dem schwarzen Island, mind. 3:1

So bleibt jede Farbe in beiden Themes lesbar.

**Schrift:** Segoe UI Variable (Text/Display), Cascadia Mono für Code.

| Token | Wert | Wofür |
|---|---|---|
| `--type-display` | 22/28 650 | Begrüssung |
| `--type-h1` | 18/24 650 | Bereich in den Einstellungen |
| `--type-h2` | 15/20 600 | Karten-, Dialog-, Island-Titel |
| `--type-h3` | 12.5/16 600 | Abschnitt über einer Gruppe |
| `--type-body` | 14/20 | Fliesstext |
| `--type-body-2` | 13/18 | Listen, sekundär |
| `--type-label` | 13/18 600 | Knöpfe, Tabs |
| `--type-caption` | 12/16 | Fussnoten |
| `--type-meta` | 11/14 | Zeit, Quelle |

**Abstände:** 4er-Raster `--space-1` bis `--space-8` = 4, 8, 12, 16, 20, 24, 32, 40 (dazu `--space-0` = 2 für Feinheiten).
**Masse:** Bedienelemente 28 / 36 / 44, Icon-Knopf 32, Icons 14 / 18 / 20 bei Strich 2 / 1.75.

**Bewegung:**

| Token | Dauer | Wofür |
|---|---|---|
| `--dur-press` | 90 ms | Druck |
| `--dur-fast` | 150 ms | Hover |
| `--dur-base` | 220 ms | Zustand, Einblenden |
| `--dur-slow` | 340 ms | Zuklappen |
| `--dur-island` | 460 ms | Island öffnen |

Kurven: `--ease-standard`, `--ease-enter` (weich auslaufend), `--ease-exit`, `--ease-island-open` (ein Hauch Federung), `--ease-island-close`. Animiert werden nur transform und opacity sowie Breite und Höhe des Island-Rahmens. Bei «Bewegung reduzieren» wird alles zu einem kurzen Überblenden.

## Komponenten und Zustände

Knopf (primär, standard, leise, gefahr, klein), Textknopf, Icon-Knopf, Senden/Mikrofon/Stopp, Tooltip (`data-tip`), Textfeld/Suchfeld/Textbereich, Auswahl, Schalter, Checkbox, Radio, Schieberegler, Segmente/Tabs, Badge, Chip, Statuspunkt, Karte, Liste mit Zeilen, Abschnitt/Fussnote/Bereich, Aufklappen, Meldung (Fehler, Hinweis, Warnung, Erfolg), Fortschritt und Pegel, Spinner, Tippen, Popover/Menü, Dialog, Tastenkappe, Farbwahl, Leerzustand.

Alle haben dieselben Zustände:

| Zustand | Darstellung |
|---|---|
| Hover | eine Stufe mehr Fläche |
| Aktiv | leicht eingedrückt |
| Fokus | Ring, nur per Tastatur |
| Deaktiviert | 40 % |
| Laden | `aria-busy="true"` |
| Fehler | `aria-invalid="true"` bzw. Gefahr |
| Gewählt | `.on`, `:checked`, `aria-pressed`, `aria-checked` |

## Island

Geschlossen ist das Island schwarz und ohne Text, die Augen stehen exakt in der Mitte. Zustände über `data-state`:

| Zustand | Darstellung |
|---|---|
| `idle` | Augen zu (zwei Striche), beim Darüberfahren wach |
| `busy` / `control` | Augen schauen hin und her, bei `control` mit Stopp-Knopf |
| `done` | ^ ^ mit kurzem Hüpfen |
| `error` | flache Augen in Gefahrenfarbe |
| `timer` / `alarm` | runde Augen mit Fortschrittslinie |
| `listen` | Augen hoch, Aufnahmepunkt |
| `music` | Cover und Pegel, der aus der Mitte wächst |
| `peek` | Mitteilung mit Text, nur kurz |
| `notch` | minimiert, bündig am Rand |

Beim Öffnen wächst der Rahmen symmetrisch. Jeder Inhalt ist an der Mitte verankert und wird nur aufgedeckt, nichts fliesst neu um. Ein maximierter Zustand und eigene Ansichten für Automationen, Projekte und Plugins gibt es in der App noch nicht. Kommen sie dazu, nutzen sie dasselbe Raster.

## Raster der Ansichten

- **Island offen:** 500 px breit, Rand 16 (`--view-x`), Inhalt 468 px.
- **Karten:** Radius 16, innen 12–16, Abstand 12.
- **Listenzeilen:** mind. 44 hoch, links und rechts 16, Trennlinie eingerückt.
- **Abschnitte:** 24 über einer Gruppe, Fussnote 8 darunter. Bereichstitel 32 Abstand.
- **Höhe:** höchstens 75 % des Bildschirms. Die Eingabe liegt nie im scrollenden Bereich. Bei wenig Höhe werden zuerst die Abstände kleiner.

## Erscheinungsbild

Einstellung «Erscheinungsbild»: Dunkel (Standard), Hell oder System. `app.js` setzt `data-theme` auf `<html>`. Bei «System» folgt es der Windows-Einstellung. `main.js` setzt zusätzlich `nativeTheme.themeSource` für native Elemente (Dropdown-Listen, Scrollbalken).

## Regeln für neuen Code

1. Keine Farbe, Grösse, Rundung oder Dauer als Zahl in Komponenten oder Ansichten. Fehlt ein Wert, gehört er in `tokens.css`.
2. Erst eine bestehende Komponente nehmen. Eine neue Variante nur mit eigenem Zweck und in `components.css`.
3. Kein Inline-Style in `app.js` ausser für Messwerte (Breite eines Balkens, Fortschritt). Farben über Klassen.
4. Jede Interaktion braucht Hover, Fokus und Deaktiviert. Ziele mindestens 28 px, Listenzeilen 44 px.
5. Neue Bewegung nur mit den Bewegungs-Tokens und nur mit transform oder opacity.

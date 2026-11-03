# Release-Signaturen

Signaturen (`update-signature.json`) für Releases, die ohne das Secret
`BUDDY_UPDATE_SIGNING_KEY` gebaut wurden. Der Workflow «Release signieren»
prüft eine Datei hier gegen `latest.yml` und den Installer des Releases und
hängt sie dann ans Release. Die Dateien enthalten nur öffentliche Daten
(Version, Prüfsumme, Signatur), keinen Schlüssel.

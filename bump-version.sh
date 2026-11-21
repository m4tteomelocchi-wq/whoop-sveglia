#!/bin/sh
# Alza il numero di versione in tutti i riferimenti, così Bluefy non tiene file vecchi in cache.
cd "$(dirname "$0")"
old=$(grep -o 'app.js?v=[0-9]*' index.html | cut -d= -f2)
new=$((old + 1))
sed -i '' -E "s/\?v=$old'/?v=$new'/g; s/\?v=$old\"/?v=$new\"/g; s/Versione $old</Versione $new</; s/versione $old\)/versione $new)/" index.html app.js strap.js reminder.js
sed -i '' -E "s/APP_VERSION = $old;/APP_VERSION = $new;/" app.js
printf '{ "v": %s }\n' "$new" > version.json
echo "versione $old → $new"

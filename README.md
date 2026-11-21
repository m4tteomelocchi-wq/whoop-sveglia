# Sveglia Whoop

Web app per usare la sveglia a vibrazione di un **WHOOP 5.0 / MG** senza abbonamento.
Si collega al braccialetto via Web Bluetooth, ne corregge l'orologio e scrive le sveglie
direttamente nel firmware, che poi vibra da solo anche col telefono spento.

**App:** https://m4tteomelocchi-wq.github.io/whoop-sveglia/ (su iPhone va aperta in [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055))

## Come funziona

- Il firmware ha 6 slot sveglia, ma ognuno suona una sola volta. L'app arma le prossime 6
  occorrenze della settimana; la sveglia di prova prende in prestito lo slot 6 e lo restituisce
  appena ha suonato.
- Le sveglie scattano dall'orologio interno del braccialetto: telefono e app non servono.
- Ogni sveglia scritta viene riletta dal braccialetto, così si sa che è stata memorizzata davvero.
- Senza l'app ufficiale nessuno risincronizza più l'orologio del braccialetto: lo fa questa
  app a ogni connessione.

| File | Contenuto |
|---|---|
| `whoop5.js` | framing, CRC e corpi dei comandi |
| `strap.js` | connessione Web Bluetooth e richiesta/risposta |
| `schedule.js` | calcolo delle prossime occorrenze (ora legale inclusa) |
| `app.js`, `index.html` | interfaccia |

## Test

```sh
bun test/whoop5.test.mjs        # frame identici ai golden di NOOP
bun test/schedule.test.mjs      # pianificazione, salti, ora legale
bun test/strap.sim.test.mjs     # client contro il braccialetto simulato (test/sim-strap.mjs)
```

## Crediti

Il protocollo è documentato dalla comunità per interoperabilità: in particolare da
[ryanbr/noop](https://github.com/ryanbr/noop) (`docs/PROTOCOL_ALARMS.md`) e da
[eugenehp/whoop-rs](https://github.com/eugenehp/whoop-rs). Progetto non ufficiale, senza alcun
legame con WHOOP, Inc. Non usarlo come unica sveglia per impegni critici.

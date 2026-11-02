# Facturación

Emite Facturas C (monotributo) a consumidor final en tandas. Se cargan una vez la fecha, el período y el precio por sesión, se agrega una línea por paciente (DNI, nombre y sesiones) y con un botón se piden todos los CAE a ARCA. Cada factura sale en PDF con el QR obligatorio y se le puede mandar por WhatsApp con un toque.

Es multiusuario: cada cuenta tiene su usuario y contraseña, sus datos fiscales, su certificado de ARCA, su punto de venta, sus pacientes, su historial y su mensaje de WhatsApp. Ninguna cuenta ve los datos de otra.

Cada paciente puede tener obra social, plan y número de socio, que aparecen en la factura.

Corre en **Cloudflare Workers** y usa:

- **D1** para usuarios, pacientes, facturas y sesiones.
- **R2** para los PDF de las facturas.
- **Static Assets** para las pantallas.

## Probarla en tu compu

Necesitás Node 20 o más nuevo.

```bash
npm install
npm run db:local                     # crea la base local
npm run usuario -- nuevo tu-usuario  # crea una cuenta (te pide la contraseña)
npm run dev                          # http://localhost:8787
```

El archivo `.dev.vars` tiene los secretos locales (`SECRETO_DATOS` y `COOKIE_SEGURA=false`) y no se sube a git.

**Todo es real:** cada factura se emite en ARCA con validez fiscal. Por eso, para facturar, la cuenta necesita sí o sí su certificado de ARCA.

**Simulación solo para desarrollo:** para probar cambios en el código sin emitir facturas reales, levantá el servidor con `npx wrangler dev --var SIMULAR_ARCA:true`. Así no se conecta con ARCA, y la pantalla lo avisa. Nunca la actives en Cloudflare.

## Publicarla en Cloudflare

Se hace una sola vez:

```bash
npx wrangler login
npx wrangler d1 create facturacion          # copiá el database_id que te muestra en wrangler.jsonc
npx wrangler r2 bucket create facturacion-archivos
openssl rand -base64 32 | npx wrangler secret put SECRETO_DATOS
npm run db:remoto
npm run deploy
npm run usuario -- nuevo tu-usuario --remoto
```

Cada vez que cambies algo: `npm run deploy`. Si hay migraciones nuevas, antes corré `npm run db:remoto`.

> **Importante:** guardá `SECRETO_DATOS` en un lugar seguro. Con él se cifran las claves privadas de ARCA y se firman los enlaces de las facturas. Si se pierde, cada cuenta tiene que volver a generar su certificado.

**Plan de Workers:** conviene el pago (USD 5 por mes). El gratuito limita el tiempo de procesamiento a 10 ms por pedido, y armar los PDF y firmar el acceso a ARCA pasa ese límite.

### Cuentas

No hay registro público: las cuentas se crean desde la terminal.

```bash
npm run usuario -- nuevo <usuario> --remoto
npm run usuario -- clave <usuario> --remoto    # cambiar la contraseña (cierra sus sesiones)
npm run usuario -- lista --remoto
npm run usuario -- borrar <usuario> --remoto
```

Cada persona puede cambiar su contraseña desde la pestaña **Cuenta**.

## Conectar una cuenta con ARCA

Todo se hace desde la pestaña **Cuenta**:

1. **Datos:** completar nombre, CUIT, domicilio, inicio de actividades y punto de venta.
2. **Pedido de certificado:** apretar **Descargar pedido**. La app genera la clave privada, la guarda cifrada y descarga el archivo `.csr`.
3. **Certificado en ARCA:** en arca.gob.ar, con clave fiscal nivel 3:
   - En **Administración de Certificados Digitales**, agregar un alias, subir el `.csr` y descargar el certificado.
   - En **Administrador de Relaciones de Clave Fiscal**, crear una nueva relación: **ARCA → WebServices → Facturación Electrónica**, con el alias como representante.
   - En **Administración de puntos de venta y domicilios**, crear un punto de venta **"Factura Electrónica – Monotributo – Web Services"** (el de "Comprobantes en línea" no sirve) y cargar su número en la app.
4. **Subir el certificado:** en la app, **Elegir archivo .crt**. Se acepta en formato PEM o DER, y la app verifica que corresponda a la clave que generó.
5. **Listo:** desde ese momento se puede facturar. Conviene emitir primero una factura de $1 al propio DNI, revisarla en ARCA y anularla con una nota de crédito desde "Comprobantes en línea".

## Enviar las facturas por WhatsApp

Se envían desde tu propio WhatsApp, gratis y sin cuentas de Meta:

- Al emitir, cada paciente que tiene teléfono muestra un botón **WhatsApp**. Lo tocás y se abre su chat (en el celular o en WhatsApp Web) con el mensaje ya escrito, y solo apretás enviar.
- El mensaje lleva un enlace secreto para descargar la factura en PDF, sin necesidad de usuario. El enlace está firmado: no se puede adivinar ni usar para abrir otra factura.
- El texto del mensaje se edita en **Cuenta → Mensaje de WhatsApp**, con `{nombre}`, `{periodo}`, `{importe}` y `{enlace}`.
- A los pacientes sin teléfono se les puede **copiar el enlace** de la factura.

No es 100% automático a propósito: mandar mensajes solo, sin tocar nada, exige la API paga de WhatsApp Business o bots no oficiales que pueden hacer que bloqueen el número.

## Detalles

- **Datos de la factura:** concepto servicios (2), DNI (96), receptor Consumidor Final (5), en pesos y sin IVA.
- **Fecha:** ARCA acepta facturas de servicios con fecha de hasta 10 días antes o después de hoy.
- **Numeración:** se piden de a una y en orden. Un candado en D1 evita dos tandas simultáneas de la misma cuenta. Si se corta la conexión en medio de una factura, la app consulta a ARCA si quedó emitida y la recupera.
- **Copia de los datos del emisor:** cada factura guarda los datos del emisor de ese momento, así el PDF no cambia si después se edita la cuenta.
- **Seguridad:**
  - Contraseñas con PBKDF2.
  - Sesiones de 12 horas en cookie HttpOnly con SameSite=Strict.
  - Bloqueo tras 10 intentos fallidos en 15 minutos.
  - Claves privadas cifradas con AES-GCM.
  - Enlaces de descarga de facturas firmados con HMAC: no se pueden adivinar.

```bash
npm test             # pruebas (incluyen verificar con OpenSSL la firma para ARCA y el pedido de certificado)
npm run typecheck
```

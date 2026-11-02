ALTER TABLE usuarios ADD COLUMN mensaje_whatsapp TEXT NOT NULL DEFAULT 'Hola {nombre}, te paso la factura de las sesiones de {periodo} por {importe}. La podés descargar acá: {enlace}';
UPDATE usuarios SET wa_token = NULL, wa_numero_id = '';
